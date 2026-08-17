import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync, type Dirent } from "node:fs"
import path from "node:path"

import type { RuntimeDatabase } from "../runtime/database.js"

const RETENTION_DAYS = 90
const ATTACHMENT_FILE_RETENTION_DAYS = 3
const ORPHAN_ATTACHMENT_GRACE_MS = 24 * 60 * 60 * 1000
const activeReferenceThreadRetentionFence = `NOT EXISTS (
  SELECT 1 FROM learning_source_observations observation
  WHERE observation.thread_id=support_threads.id AND (
    observation.processing_status='running'
    OR observation.current_run_id IS NOT NULL
    OR observation.lock_token IS NOT NULL
    OR observation.locked_at IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM reference_learning_results result
      JOIN memory_maintenance_runs run ON run.id=result.run_id
      WHERE result.observation_id=observation.id AND run.status='running'
    )
  )
)`

export type RetentionResult = {
  cutoff: string
  attachmentFileCutoff: string
  deletedThreads: number
  deletedAdminChatSessions: number
  deletedAdminChatTurns: number
  deletedMessageEvents: number
  deletedReplies: number
  deletedOutputOwnership: number
  deletedTransientEvents: number
  deletedAttachments: number
  expiredAttachmentRows: number
  deletedAttachmentFiles: number
  deletedOrphanFiles: number
  failedAttachmentFiles: number
  deletedAttachmentDirectories: number
}

type IdRow = { id: string }
type PathRow = { storage_path: string }
type StoredAttachmentRow = IdRow & PathRow
type RemovalResult = "deleted" | "missing" | "skipped" | "failed"

export class RetentionService {
  constructor(private readonly database: RuntimeDatabase, private readonly attachmentRoot?: string) {}

  run(now = new Date(), batchSize = 5000): RetentionResult {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const attachmentFileCutoff = new Date(
      now.getTime() - ATTACHMENT_FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString()
    const boundedBatch = Math.min(Math.max(batchSize, 1), 10_000)
    let deletedThreads = 0
    let deletedAdminChatSessions = 0
    let deletedAdminChatTurns = 0
    let deletedMessageEvents = 0
    let deletedReplies = 0
    let deletedOutputOwnership = 0
    let deletedTransientEvents = 0
    let deletedAttachments = 0
    let expiredAttachmentRows = 0
    let deletedAttachmentFiles = 0
    let deletedOrphanFiles = 0
    let failedAttachmentFiles = 0
    let deletedAttachmentDirectories = 0
    const files: string[] = []

    while (true) {
      const threads = this.database.prepare(`SELECT id FROM support_threads
        WHERE latest_message_at<? AND ${activeReferenceThreadRetentionFence}
        ORDER BY latest_message_at,id LIMIT ${boundedBatch}`).all(cutoff) as IdRow[]
      if (threads.length === 0) break
      const threadIds = threads.map((row) => row.id)
      const threadPlaceholders = threadIds.map(() => "?").join(",")

      this.database.transaction(() => {
        this.database.prepare("UPDATE metadata SET value='1' WHERE key='allow_maintenance_delete'").run()
        try {
          const eligibleThreads = this.database.prepare(`SELECT id FROM support_threads
            WHERE id IN (${threadPlaceholders}) AND latest_message_at<?
              AND ${activeReferenceThreadRetentionFence}
            ORDER BY latest_message_at,id`).all(...threadIds, cutoff) as IdRow[]
          if (eligibleThreads.length === 0) return
          const eligibleThreadIds = eligibleThreads.map((row) => row.id)
          const eligibleThreadPlaceholders = eligibleThreadIds.map(() => "?").join(",")
          const replies = this.database.prepare(`SELECT id FROM support_replies
            WHERE thread_id IN (${eligibleThreadPlaceholders})`).all(...eligibleThreadIds) as IdRow[]
          const replyIds = replies.map((row) => row.id)
          const eventRows = this.database.prepare(`SELECT DISTINCT linked.message_event_id AS id
            FROM support_thread_messages linked
            WHERE linked.thread_id IN (${eligibleThreadPlaceholders})
            AND NOT EXISTS (
              SELECT 1 FROM support_thread_messages retained
              WHERE retained.message_event_id=linked.message_event_id
              AND retained.thread_id NOT IN (${eligibleThreadPlaceholders})
            )`).all(...eligibleThreadIds, ...eligibleThreadIds) as IdRow[]
          const eventIds = eventRows.map((row) => row.id)
          if (eventIds.length > 0) {
            const placeholders = eventIds.map(() => "?").join(",")
            const attachments = this.database.prepare(`SELECT storage_path FROM support_message_attachments
              WHERE message_event_id IN (${placeholders})`).all(...eventIds) as PathRow[]
            deletedAttachments += attachments.length
            files.push(...attachments.map((row) => row.storage_path).filter(Boolean))
          }
          if (replyIds.length > 0) {
            const placeholders = replyIds.map(() => "?").join(",")
            const attachments = this.database.prepare(`SELECT storage_path FROM support_attachments
              WHERE reply_id IN (${placeholders})`).all(...replyIds) as PathRow[]
            deletedAttachments += attachments.length
            files.push(...attachments.map((row) => row.storage_path).filter(Boolean))
          }
          if (replyIds.length > 0) {
            const placeholders = replyIds.map(() => "?").join(",")
            const memoryEvents = this.database.prepare(`DELETE FROM memory_events
              WHERE reply_record_id IN (${placeholders}) AND type IN ('question','reply','attachment')
              AND NOT EXISTS (SELECT 1 FROM memory_version_evidence ve WHERE ve.event_id=memory_events.id)
              AND NOT EXISTS (SELECT 1 FROM memory_versions mv WHERE mv.created_by_event_id=memory_events.id)`).run(...replyIds)
            deletedTransientEvents += Number(memoryEvents.changes)
            const deleted = this.database.prepare(`DELETE FROM support_replies WHERE id IN (${placeholders})`).run(...replyIds)
            deletedReplies += Number(deleted.changes)
          }
          const deletedThreadRows = this.database.prepare(`DELETE FROM support_threads
            WHERE id IN (${eligibleThreadPlaceholders}) AND latest_message_at<?
              AND ${activeReferenceThreadRetentionFence}`).run(...eligibleThreadIds, cutoff)
          deletedThreads += Number(deletedThreadRows.changes)
          if (eventIds.length > 0) {
            const placeholders = eventIds.map(() => "?").join(",")
            const deletedEvents = this.database.prepare(`DELETE FROM support_message_events
              WHERE id IN (${placeholders})
              AND NOT EXISTS (SELECT 1 FROM support_thread_messages retained WHERE retained.message_event_id=support_message_events.id)`).run(...eventIds)
            deletedMessageEvents += Number(deletedEvents.changes)
          }
        } finally {
          this.database.prepare("UPDATE metadata SET value='0' WHERE key='allow_maintenance_delete'").run()
        }
      })
      if (threads.length < boundedBatch) break
    }

    while (true) {
      const batch = this.database.transaction(() => {
        this.database.prepare("UPDATE metadata SET value='1' WHERE key='allow_maintenance_delete'").run()
        try {
          const events = this.database.prepare(`SELECT event.id FROM support_message_events event
            WHERE event.created_at<? AND NOT EXISTS (
              SELECT 1 FROM support_thread_messages linked WHERE linked.message_event_id=event.id
            ) AND NOT EXISTS (
              SELECT 1 FROM learning_source_observations observation
              WHERE observation.message_event_id=event.id AND (
                observation.processing_status='running'
                OR observation.current_run_id IS NOT NULL
                OR observation.lock_token IS NOT NULL
                OR observation.locked_at IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM reference_learning_results result
                  JOIN memory_maintenance_runs run ON run.id=result.run_id
                  WHERE result.observation_id=observation.id AND run.status='running'
                )
              )
            ) ORDER BY event.created_at,event.id LIMIT ${boundedBatch}`).all(cutoff) as IdRow[]
          if (events.length === 0) {
            return { candidateCount: 0, deletedCount: 0, attachmentCount: 0, attachmentPaths: [] as string[] }
          }
          const eventIds = events.map((event) => event.id)
          const placeholders = eventIds.map(() => "?").join(",")
          const attachments = this.database.prepare(`SELECT storage_path FROM support_message_attachments
            WHERE message_event_id IN (${placeholders})`).all(...eventIds) as PathRow[]
          const deleted = this.database.prepare(`DELETE FROM support_message_events
            WHERE id IN (${placeholders}) AND created_at<? AND NOT EXISTS (
              SELECT 1 FROM support_thread_messages retained
              WHERE retained.message_event_id=support_message_events.id
            ) AND NOT EXISTS (
              SELECT 1 FROM learning_source_observations observation
              WHERE observation.message_event_id=support_message_events.id AND (
                observation.processing_status='running'
                OR observation.current_run_id IS NOT NULL
                OR observation.lock_token IS NOT NULL
                OR observation.locked_at IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM reference_learning_results result
                  JOIN memory_maintenance_runs run ON run.id=result.run_id
                  WHERE result.observation_id=observation.id AND run.status='running'
                )
              )
            )`).run(...eventIds, cutoff)
          return {
            candidateCount: events.length,
            deletedCount: Number(deleted.changes),
            attachmentCount: attachments.length,
            attachmentPaths: attachments.map((attachment) => attachment.storage_path).filter(Boolean),
          }
        } finally {
          this.database.prepare("UPDATE metadata SET value='0' WHERE key='allow_maintenance_delete'").run()
        }
      })
      if (batch.candidateCount === 0) break
      deletedMessageEvents += batch.deletedCount
      deletedAttachments += batch.attachmentCount
      files.push(...batch.attachmentPaths)
      if (batch.candidateCount < boundedBatch) break
    }

    while (true) {
      const replies = this.database.prepare(`SELECT id FROM support_replies
        WHERE thread_id IS NULL AND created_at<? ORDER BY created_at,id LIMIT ${boundedBatch}`).all(cutoff) as IdRow[]
      if (replies.length === 0) break
      const ids = replies.map((row) => row.id)
      const placeholders = ids.map(() => "?").join(",")
      const attachments = this.database.prepare(`SELECT storage_path FROM support_attachments
        WHERE reply_id IN (${placeholders})`).all(...ids) as PathRow[]
      deletedAttachments += attachments.length
      files.push(...attachments.map((row) => row.storage_path).filter(Boolean))
      this.database.transaction(() => {
        this.database.prepare("UPDATE metadata SET value='1' WHERE key='allow_maintenance_delete'").run()
        try {
          const memoryEvents = this.database.prepare(`DELETE FROM memory_events
            WHERE reply_record_id IN (${placeholders}) AND type IN ('question','reply','attachment')
            AND NOT EXISTS (SELECT 1 FROM memory_version_evidence ve WHERE ve.event_id=memory_events.id)
            AND NOT EXISTS (SELECT 1 FROM memory_versions mv WHERE mv.created_by_event_id=memory_events.id)`).run(...ids)
          deletedTransientEvents += Number(memoryEvents.changes)
          const deleted = this.database.prepare(`DELETE FROM support_replies WHERE id IN (${placeholders})`).run(...ids)
          deletedReplies += Number(deleted.changes)
        } finally {
          this.database.prepare("UPDATE metadata SET value='0' WHERE key='allow_maintenance_delete'").run()
        }
      })
      if (replies.length < boundedBatch) break
    }

    while (true) {
      const ownership = this.database.prepare(`SELECT id FROM telegram_output_ownership
        WHERE thread_id IS NULL AND reply_id IS NULL AND notification_id IS NULL AND created_at<?
        ORDER BY created_at,id LIMIT ${boundedBatch}`).all(cutoff) as IdRow[]
      if (ownership.length === 0) break
      const ids = ownership.map((row) => row.id)
      const placeholders = ids.map(() => "?").join(",")
      const deleted = this.database.prepare(`DELETE FROM telegram_output_ownership
        WHERE id IN (${placeholders}) AND thread_id IS NULL AND reply_id IS NULL AND notification_id IS NULL
          AND created_at<?`).run(...ids, cutoff)
      deletedOutputOwnership += Number(deleted.changes)
      if (ownership.length < boundedBatch) break
    }

    const adminChatSessions = this.database.prepare(`SELECT session.id FROM admin_chat_sessions session
      WHERE session.updated_at<? AND NOT EXISTS (
        SELECT 1 FROM admin_chat_turns turn
        WHERE turn.session_id=session.id AND turn.status IN ('pending','generating')
      ) ORDER BY session.updated_at,session.id LIMIT 500`).all(cutoff) as IdRow[]
    if (adminChatSessions.length > 0) {
      const sessionIds = adminChatSessions.map((row) => row.id)
      const placeholders = sessionIds.map(() => "?").join(",")
      const adminAttachments = this.database.prepare(`SELECT attachment.storage_path FROM admin_chat_attachments attachment
        JOIN admin_chat_turns turn ON turn.id=attachment.turn_id
        WHERE turn.session_id IN (${placeholders})`).all(...sessionIds) as PathRow[]
      deletedAttachments += adminAttachments.length
      files.push(...adminAttachments.map((row) => row.storage_path).filter(Boolean))
      this.database.transaction(() => {
        const turns = this.database.prepare(`SELECT COUNT(*) AS count FROM admin_chat_turns
          WHERE session_id IN (${placeholders})`).get(...sessionIds) as { count: number }
        const deleted = this.database.prepare(`DELETE FROM admin_chat_sessions
          WHERE id IN (${placeholders})`).run(...sessionIds)
        deletedAdminChatTurns += Number(turns.count)
        deletedAdminChatSessions += Number(deleted.changes)
      })
    }

    const expiredAttachments = this.expireStoredAttachmentFiles(attachmentFileCutoff, boundedBatch)
    expiredAttachmentRows += expiredAttachments.expiredRows
    files.push(...expiredAttachments.paths)

    const referencedFiles = this.referencedAttachmentFiles()
    new Set(files).forEach((file) => {
      const candidate = this.resolveInsideAttachmentRoot(file)
      if (!candidate) {
        failedAttachmentFiles += 1
        return
      }
      if (referencedFiles.has(candidate)) return
      const result = this.removeAttachment(candidate)
      if (result === "deleted") deletedAttachmentFiles += 1
      if (result === "failed" || result === "skipped") failedAttachmentFiles += 1
    })
    const orphanCleanup = this.cleanupOrphanAttachments(now, referencedFiles)
    deletedOrphanFiles += orphanCleanup.deletedFiles
    failedAttachmentFiles += orphanCleanup.failedFiles
    deletedAttachmentDirectories += orphanCleanup.deletedDirectories
    this.database.connection.exec("PRAGMA wal_checkpoint(PASSIVE)")
    this.database.connection.exec("PRAGMA incremental_vacuum(2000)")
    return {
      cutoff,
      attachmentFileCutoff,
      deletedThreads,
      deletedAdminChatSessions,
      deletedAdminChatTurns,
      deletedMessageEvents,
      deletedReplies,
      deletedOutputOwnership,
      deletedTransientEvents,
      deletedAttachments,
      expiredAttachmentRows,
      deletedAttachmentFiles,
      deletedOrphanFiles,
      failedAttachmentFiles,
      deletedAttachmentDirectories,
    }
  }

  private expireStoredAttachmentFiles(cutoff: string, batchSize: number): {
    expiredRows: number
    paths: string[]
  } {
    const targets = [
      {
        table: "support_message_attachments",
        index: "support_message_attachments_retention_idx",
        activeGuard: `NOT EXISTS (
          SELECT 1 FROM support_thread_messages linked
          JOIN support_threads thread ON thread.id=linked.thread_id
          WHERE linked.message_event_id=attachment.message_event_id
            AND thread.status IN ('collecting','generating')
        ) AND NOT EXISTS (
          SELECT 1 FROM learning_source_observations observation
          WHERE observation.message_event_id=attachment.message_event_id AND (
            observation.processing_status='running'
            OR observation.current_run_id IS NOT NULL
            OR observation.lock_token IS NOT NULL
            OR observation.locked_at IS NOT NULL
          )
        )`,
      },
      {
        table: "support_attachments",
        index: "support_attachments_retention_idx",
        activeGuard: `NOT EXISTS (
          SELECT 1 FROM support_replies reply
          LEFT JOIN support_threads thread ON thread.id=reply.thread_id
          WHERE reply.id=attachment.reply_id AND (
            reply.status IN ('pending','queued','generating','sending','correcting')
            OR thread.status IN ('collecting','generating')
            OR EXISTS (
              SELECT 1 FROM learning_source_observations observation
              WHERE observation.thread_id=thread.id AND (
                observation.processing_status='running'
                OR observation.current_run_id IS NOT NULL
                OR observation.lock_token IS NOT NULL
                OR observation.locked_at IS NOT NULL
              )
            )
          )
        )`,
      },
      {
        table: "admin_chat_attachments",
        index: "admin_chat_attachments_retention_idx",
        activeGuard: `NOT EXISTS (
          SELECT 1 FROM admin_chat_turns turn
          WHERE turn.id=attachment.turn_id AND turn.status IN ('pending','generating')
        )`,
      },
    ] as const
    let expiredRows = 0
    const paths: string[] = []

    for (const target of targets) {
      while (true) {
        const rows = this.database.prepare(`SELECT attachment.id,attachment.storage_path
          FROM ${target.table} AS attachment INDEXED BY ${target.index}
          WHERE attachment.storage_path<>'' AND attachment.created_at<? AND ${target.activeGuard}
          ORDER BY attachment.created_at,attachment.id LIMIT ${batchSize}`).all(cutoff) as StoredAttachmentRow[]
        if (rows.length === 0) break
        const ids = rows.map((row) => row.id)
        const placeholders = ids.map(() => "?").join(",")
        const cleared = this.database.prepare(`UPDATE ${target.table} SET storage_path=''
          WHERE id IN (${placeholders}) AND storage_path<>'' AND created_at<?`).run(...ids, cutoff)
        expiredRows += Number(cleared.changes)
        paths.push(...rows.map((row) => row.storage_path).filter(Boolean))
        if (rows.length < batchSize) break
      }
    }
    return { expiredRows, paths }
  }

  private referencedAttachmentFiles(): Set<string> {
    const rows = this.database.prepare(`SELECT storage_path FROM support_message_attachments
      WHERE storage_path<>'' UNION SELECT storage_path FROM support_attachments WHERE storage_path<>''
      UNION SELECT storage_path FROM admin_chat_attachments WHERE storage_path<>''`).all() as PathRow[]
    return new Set(rows.map((row) => this.resolveInsideAttachmentRoot(row.storage_path)).filter((file): file is string => Boolean(file)))
  }

  private cleanupOrphanAttachments(now: Date, referencedFiles: ReadonlySet<string>): {
    deletedFiles: number
    failedFiles: number
    deletedDirectories: number
  } {
    if (!this.attachmentRoot) return { deletedFiles: 0, failedFiles: 0, deletedDirectories: 0 }
    const root = path.resolve(this.attachmentRoot)
    try {
      const rootStat = lstatSync(root)
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        return { deletedFiles: 0, failedFiles: 1, deletedDirectories: 0 }
      }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { deletedFiles: 0, failedFiles: 0, deletedDirectories: 0 }
        : { deletedFiles: 0, failedFiles: 1, deletedDirectories: 0 }
    }
    const directories: string[] = []
    const orphanCutoff = now.getTime() - ORPHAN_ATTACHMENT_GRACE_MS
    let deletedFiles = 0
    let failedFiles = 0
    const visit = (directory: string): void => {
      let entries: Dirent[]
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failedFiles += 1
        return
      }
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name)
        if (entry.isDirectory()) visit(candidate)
        else if (entry.isFile() && !referencedFiles.has(candidate)) {
          try {
            if (lstatSync(candidate).mtimeMs >= orphanCutoff) continue
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") failedFiles += 1
            continue
          }
          const result = this.removeAttachment(candidate)
          if (result === "deleted") deletedFiles += 1
          if (result === "failed") failedFiles += 1
        }
      }
      if (directory !== root) directories.push(directory)
    }
    visit(root)

    let deletedDirectories = 0
    directories.forEach((directory) => {
      try {
        rmdirSync(directory)
        deletedDirectories += 1
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ENOENT" && code !== "ENOTEMPTY") failedFiles += 1
      }
    })
    return { deletedFiles, failedFiles, deletedDirectories }
  }

  private resolveInsideAttachmentRoot(filePath: string): string | null {
    if (!this.attachmentRoot || !filePath) return null
    const root = path.resolve(this.attachmentRoot)
    const candidate = path.resolve(filePath)
    const relative = path.relative(root, candidate)
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
    return candidate
  }

  private removeAttachment(filePath: string): RemovalResult {
    const candidate = this.resolveInsideAttachmentRoot(filePath)
    if (!candidate) return "skipped"
    try {
      if (!this.isSafeExistingAttachmentFile(candidate)) return "skipped"
      unlinkSync(candidate)
      return "deleted"
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed"
    }
  }

  private isSafeExistingAttachmentFile(candidate: string): boolean {
    if (!this.attachmentRoot) return false
    const root = path.resolve(this.attachmentRoot)
    const rootStat = lstatSync(root)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false
    const relative = path.relative(root, candidate)
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false

    const segments = relative.split(path.sep).filter(Boolean)
    let current = root
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]!)
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) return false
      if (index < segments.length - 1 && !stat.isDirectory()) return false
      if (index === segments.length - 1 && !stat.isFile()) return false
    }

    const realRoot = realpathSync(root)
    const realCandidate = realpathSync(candidate)
    const realRelative = path.relative(realRoot, realCandidate)
    return Boolean(realRelative)
      && realRelative !== ".."
      && !realRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(realRelative)
  }
}
