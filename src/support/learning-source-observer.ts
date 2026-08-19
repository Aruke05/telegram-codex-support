import type { RuntimeDatabase } from "../runtime/database.js"
import type {
  LearningSourceObservation,
  SupportMessageEvent,
  SupportThread,
  TelegramRole,
} from "../runtime/types.js"
import type { LearningSourceStore } from "./learning-source-store.js"
import type { SupportThreadLifecycleService } from "./thread-lifecycle-service.js"
import type { SupportThreadStore } from "./thread-store.js"
import { ShadowLearningStore } from "./shadow-learning-store.js"

export type LearningSourceObserverDependencies = {
  database: RuntimeDatabase
  threads: SupportThreadStore
  observations: LearningSourceStore
  materializePendingBatch(eventId: string): SupportThread | null
  lifecycle: Pick<SupportThreadLifecycleService, "takeOverFromHuman">
}

export class LearningSourceObserver {
  private readonly shadowLearning: ShadowLearningStore

  constructor(private readonly deps: LearningSourceObserverDependencies) {
    this.shadowLearning = new ShadowLearningStore(deps.database)
  }

  observe(event: SupportMessageEvent, trustedRole?: TelegramRole): LearningSourceObservation | null {
    const group = this.deps.database.readGroups().find((candidate) => candidate.id === event.groupId)
    if (group?.purpose !== "support") return null
    const configuredRole = this.deps.database.readRoles().find((candidate) => (
      candidate.enabled
      && candidate.learningSourceEnabled
      && /^\d+$/u.test(event.senderUserId)
      && candidate.telegramUserId === event.senderUserId
    ))
    const role = trustedRole?.enabled
      && trustedRole.learningSourceEnabled
      && trustedRole.telegramUserId === event.senderUserId
      ? trustedRole
      : configuredRole
    if (!role || event.routeStatus !== "role_skipped") return null
    const serviceId = group.serviceId
    const learningMode = group.operationMode === "learning"
    const association = this.associate(event, serviceId, !learningMode)
    const shadowReference = learningMode || association.thread?.answerOperationMode === "learning"
    if (shadowReference && !configuredRole) return null
    const existing = this.deps.observations.findByMessageEvent(event.id)
    if (existing) {
      if (shadowReference && association.thread) this.shadowLearning.linkHumanAnswer({
        observationId: existing.id,
        humanMessageEventId: event.id,
        primaryThreadId: association.thread.id,
      })
      return existing
    }
    const record = (takeoverStatus: LearningSourceObservation["takeoverStatus"]): LearningSourceObservation => (
      this.deps.observations.findByMessageEvent(event.id) ?? this.deps.observations.record({
        messageEventId: event.id,
        sourceTelegramUserId: role.telegramUserId,
        sourceRole: role.role,
        threadId: association.thread?.id ?? null,
        serviceId: association.thread?.serviceId ?? serviceId,
        associationReason: association.reason,
        associationConfidence: association.confidence,
        takeoverStatus,
        classification: shadowReference ? "shadow_reference_reply" : "reference_reply",
        risk: "low",
        processingStatus: shadowReference || association.reason === "ambiguous" || association.reason === "none"
          ? "ignored"
          : "pending",
      })
    )
    if (association.reason === "ambiguous") return record("ambiguous")
    if (!association.thread) return record("not_linked")
    if (shadowReference) {
      return this.deps.database.transaction(() => {
        const observation = record(association.thread ? "thread_already_terminal" : "not_linked")
        if (association.thread) this.shadowLearning.linkHumanAnswer({
          observationId: observation.id,
          humanMessageEventId: event.id,
          primaryThreadId: association.thread.id,
        })
        return observation
      })
    }
    return this.deps.lifecycle.takeOverFromHuman(
      association.thread.id,
      role.displayName || role.username || role.telegramUserId,
      record,
      event.createdAt,
    )
  }

  reconcilePending(): number {
    const rows = this.deps.database.prepare(`SELECT observation.message_event_id
      FROM learning_source_observations observation
      WHERE observation.classification='shadow_reference_reply'
        AND NOT EXISTS (
          SELECT 1 FROM shadow_human_answer_links link WHERE link.observation_id=observation.id
        )
      ORDER BY observation.created_at,observation.id`).all() as Array<{ message_event_id: string }>
    let linked = 0
    for (const row of rows) {
      const event = this.deps.threads.getEvent(row.message_event_id)
      const observation = this.deps.observations.findByMessageEvent(event.id)
      if (!observation) continue
      const association = this.associate(event, observation.serviceId, false)
      if (!association.thread || association.thread.answerOperationMode !== "learning") continue
      if (this.shadowLearning.linkHumanAnswer({
        observationId: observation.id,
        humanMessageEventId: event.id,
        primaryThreadId: association.thread.id,
      }).length > 0) linked += 1
    }
    return linked
  }

  private associate(event: SupportMessageEvent, serviceId: string | null, allowMaterialize: boolean): {
    thread: SupportThread | null
    reason: LearningSourceObservation["associationReason"]
    confidence: number
  } {
    if (event.replyToMessageId) {
      const directEvent = this.deps.threads.getEventByTelegramMessage(event.groupId, event.replyToMessageId)
      if (directEvent) {
        const relation = this.deps.threads.getEventRelation(directEvent.id)
          ?? (allowMaterialize && this.deps.materializePendingBatch(directEvent.id)
            ? this.deps.threads.getEventRelation(directEvent.id)
            : null)
        if (relation?.thread.groupId === event.groupId && relation.relation === "origin") {
          return { thread: relation.thread, reason: "direct_question", confidence: 1 }
        }
      }

      const botThread = this.deps.threads.findThreadByBotReplyMessage(
        event.groupId,
        event.replyToMessageId,
      )
      if (botThread) {
        return { thread: botThread, reason: "direct_bot_reply", confidence: 0.99 }
      }

      const chainThread = this.findReplyChain(event.groupId, event.replyToMessageId)
      if (chainThread) return { thread: chainThread, reason: "reply_chain", confidence: 0.95 }
    }

    if (!serviceId) return { thread: null, reason: "none", confidence: 0 }
    const candidates = this.deps.threads.listRouteCandidates(event.groupId, serviceId, 2, event.createdAt)
    if (candidates.length === 1) return { thread: candidates[0]!, reason: "single_active_thread", confidence: 0.75 }
    if (candidates.length > 1) return { thread: null, reason: "ambiguous", confidence: 0 }
    return { thread: null, reason: "none", confidence: 0 }
  }

  private findReplyChain(groupId: string, initialMessageId: string): SupportThread | null {
    const visited = new Set<string>()
    let messageId: string | null = initialMessageId
    for (let depth = 0; messageId && depth < 32 && !visited.has(messageId); depth += 1) {
      visited.add(messageId)
      const botThread = this.deps.threads.findThreadByBotReplyMessage(groupId, messageId)
      if (botThread) return botThread
      const target = this.deps.threads.getEventByTelegramMessage(groupId, messageId)
      if (!target) return null
      const observed = this.deps.observations.findByMessageEvent(target.id)
      if (observed?.threadId) {
        const thread = this.deps.threads.getThread(observed.threadId)
        if (thread.groupId === groupId) return thread
      }
      const relation = this.deps.threads.getEventRelation(target.id)
      if (relation?.thread.groupId === groupId) return relation.thread
      messageId = target.replyToMessageId
    }
    return null
  }
}
