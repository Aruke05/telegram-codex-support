import { randomUUID } from "node:crypto"

import type { ThreadRouteResult } from "../codex/schemas.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type {
  ProjectServiceRecord,
  RuntimeGroup,
  SupportMessageEvent,
  SupportRouteClarification,
  SupportThread,
  TelegramRole,
} from "../runtime/types.js"
import type { SupportAttachmentContext } from "./agent.js"
import type { LearningSourceObserver } from "./learning-source-observer.js"
import { operatorCopy } from "./operator-copy.js"
import { routeSupportMessage } from "./routing.js"
import type {
  SenderRouteFocusContext,
  SenderRoutePendingContext,
  SupportThreadRouterPort,
} from "./thread-router.js"
import { SupportThreadStore } from "./thread-store.js"

export type IncomingThreadMessage = {
  groupId: string
  messageId: string
  senderId: string
  senderUsername: string | null
  senderDisplayName: string | null
  fromBot: boolean
  accountOwnerOutgoing?: boolean
  replyToMessageId: string | null
  messageThreadId: string | null
  replyTargetIsBot: boolean
  text: string
  attachments: SupportAttachmentContext[]
  mediaGroupId?: string | null
  createdAt?: string
}

type CorrectionInput = {
  group: RuntimeGroup
  role: TelegramRole
  event: SupportMessageEvent
  correctionText: string
  replyToMessageId: string | null
  replyTargetIsBot: boolean
}

type PendingBatch = {
  id: string
  group: RuntimeGroup
  service: ProjectServiceRecord
  events: SupportMessageEvent[]
  timer: ReturnType<typeof setTimeout>
}

type PendingPresenceReply = {
  groupId: string
  timer: ReturnType<typeof setTimeout>
}

export type SupportThreadCoordinatorDependencies = {
  database: RuntimeDatabase
  store: SupportThreadStore
  router: SupportThreadRouterPort
  batchWindowMs?: number | (() => number)
  wake(): void
  cancelStale?(): void
  sendHelp?(group: RuntimeGroup, text: string, replyToMessageId: string): Promise<void>
  sendRouteClarification?(input: {
    group: RuntimeGroup
    service: ProjectServiceRecord
    event: SupportMessageEvent
    clarification: SupportRouteClarification
    text: string
  }): Promise<{ replyId: string | null }>
  sendStatusUpdate?(input: {
    group: RuntimeGroup
    service: ProjectServiceRecord
    thread: SupportThread
    event: SupportMessageEvent
    text: string
  }): Promise<{ replyId: string | null }>
  correct?(input: CorrectionInput): Promise<void>
  alert?(group: RuntimeGroup, reason: string, event: SupportMessageEvent): Promise<void>
  learningSourceObserver?: Pick<LearningSourceObserver, "observe" | "reconcilePending">
  sendPresenceReply?(input: {
    group: RuntimeGroup
    event: SupportMessageEvent
    text: string
  }): Promise<string>
}

const presenceReplyDelayMs = 5_000
const presenceCheckPattern = /^有人在吗[?？!！。~～]*$/u

function normalizeService(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[\s_-]+/g, "")
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString()
}

function normalizedEvent(event: SupportMessageEvent): SupportMessageEvent {
  return {
    ...event,
    safeText: event.safeText.trim(),
    attachmentSummary: event.attachmentSummary.trim(),
  }
}

function originalQuestionFragment(event: SupportMessageEvent, fallback: string): string {
  if (event.safeText.length > 0) return event.safeText
  if (event.attachmentSummary.trim()) return event.attachmentSummary
  return fallback
}

function isPresenceCheck(event: Pick<SupportMessageEvent, "safeText" | "attachmentSummary">): boolean {
  return event.attachmentSummary.trim().length === 0
    && presenceCheckPattern.test(event.safeText.trim().replace(/\s+/gu, ""))
}

function mentionedHumanPriorityUserIds(text: string, roles: TelegramRole[]): string[] {
  const usernames = new Set(
    [...text.matchAll(/(?<![A-Za-z0-9_])@([A-Za-z0-9_]{1,80})(?![A-Za-z0-9_])/gu)]
      .flatMap((match) => match[1] ? [match[1].toLocaleLowerCase("en-US")] : []),
  )
  if (usernames.size === 0) return []
  return [...new Set(roles.flatMap((role) => {
    const username = role.username?.replace(/^@/u, "").toLocaleLowerCase("en-US")
    return role.enabled && (role.role === "technical" || role.role === "ignored")
      && username && usernames.has(username)
      ? [role.telegramUserId]
      : []
  }))]
}

export class SupportThreadCoordinator {
  private readonly pending = new Map<string, PendingBatch>()
  private readonly routeChains = new Map<string, Promise<void>>()
  private readonly inFlightBatches = new Set<string>()
  private readonly activeBatches = new Map<string, Omit<PendingBatch, "timer">>()
  private readonly pendingPresenceReplies = new Map<string, PendingPresenceReply>()
  private readonly active = new Set<Promise<void>>()
  private readonly resolveBatchWindowMs: () => number
  private recoveryTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: SupportThreadCoordinatorDependencies) {
    const configuredBatchWindow = deps.batchWindowMs
    this.resolveBatchWindowMs = typeof configuredBatchWindow === "function"
      ? configuredBatchWindow
      : () => configuredBatchWindow ?? 30_000
  }

  accept(input: IncomingThreadMessage): SupportMessageEvent | null {
    if (input.fromBot) return null
    const group = this.deps.database.readGroups().find((item) => item.id === input.groupId)
    if (!group?.enabled || !group.telegramChatId) return null
    const roles = this.deps.database.readRoles()
    const configuredRole = roles.find((item) => item.enabled && item.telegramUserId === input.senderId)
    const timestamp = input.createdAt ?? new Date().toISOString()
    const role: TelegramRole | undefined = configuredRole ?? (input.accountOwnerOutgoing ? {
      id: randomUUID(),
      telegramUserId: input.senderId,
      username: input.senderUsername,
      displayName: input.senderDisplayName?.trim() || "当前客服账号",
      role: "operator",
      canCorrect: false,
      enabled: true,
      learningSourceEnabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    } : undefined)
    const route = routeSupportMessage({
      purpose: group.purpose,
      senderRole: role?.role ?? null,
      canCorrect: role?.canCorrect ?? false,
      text: input.text,
    })
    if (route.action === "drop") return null

    const eventStatus = route.action === "correct" ? "correction"
      : route.action === "process" && route.immediate ? "command"
        : route.action === "ignore" && role && (group.purpose === "support" || role.learningSourceEnabled) ? "role_skipped"
          : route.action === "ignore" ? "ignored"
            : "received"
    const attachmentSummary = this.attachmentSummary(input.attachments)
    const humanPriorityUserIds = group.purpose === "support" && route.action === "process" && !route.immediate
      ? mentionedHumanPriorityUserIds(input.text, roles)
      : []
    const recorded = this.deps.store.recordEvent({
      groupId: group.id,
      accountId: group.accountId,
      telegramMessageId: input.messageId,
      replyToMessageId: input.replyToMessageId,
      messageThreadId: input.messageThreadId,
      mediaGroupId: input.mediaGroupId ?? null,
      senderUserId: input.senderId,
      senderUsername: input.senderUsername,
      senderDisplayName: input.senderDisplayName,
      senderRole: role?.role ?? null,
      text: input.text,
      attachmentSummary,
      routeStatus: eventStatus,
      skipReason: route.action === "ignore" ? route.reason : null,
      humanPriorityUserIds,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    if (recorded.created && input.attachments.length > 0) {
      this.deps.store.recordAttachments(recorded.event.id, input.attachments)
    }
    if (recorded.event.routeStatus === "role_skipped") {
      this.deps.learningSourceObserver?.observe(recorded.event, role)
    }
    if (recorded.created && role && route.action === "ignore"
      && this.deps.store.resolveHumanPriorityByResponder(
        group.id, role.telegramUserId, recorded.event.id, recorded.event.createdAt,
      ) > 0) {
      this.deps.cancelStale?.()
    }
    if (recorded.created && role && route.action === "ignore") {
      this.cancelPresenceRepliesAnsweredByHuman(group.id, recorded.event.createdAt)
    }

    if (!recorded.created) {
      if (recorded.event.routeStatus === "role_skipped") return recorded.event
      if (route.action !== "process" || this.deps.store.findThreadByEvent(recorded.event.id) || this.pendingHasEvent(recorded.event.id)) {
        return recorded.event
      }
    }

    if (route.action === "help") {
      if (this.deps.sendHelp) this.track(this.deps.sendHelp(group, route.text, input.messageId))
      return recorded.event
    }
    if (route.action === "ignore") return recorded.event
    if (route.action === "correct") {
      if (role?.canCorrect && this.deps.correct) {
        this.track(this.deps.correct({
          group,
          role,
          event: recorded.event,
          correctionText: route.correctionText,
          replyToMessageId: input.replyToMessageId,
          replyTargetIsBot: input.replyTargetIsBot,
        }))
      }
      return recorded.event
    }

    if (group.purpose === "support" && !route.immediate && isPresenceCheck(recorded.event)) {
      this.schedulePresenceReply(group, recorded.event)
      return recorded.event
    }

    const service = this.resolveService(group, route.requestedService)
    if (!service) {
      this.deps.store.updateEventRoute(recorded.event.id, "ignored", "群未绑定有效服务或指定服务不存在")
      if (this.deps.alert) this.track(this.deps.alert(group, "群未绑定有效服务或指定服务不存在", recorded.event))
      return recorded.event
    }
    if (route.immediate) {
      const batchId = recorded.event.ingestBatchId ?? randomUUID()
      const event = this.deps.store.assignEventBatch(recorded.event.id, batchId)
      this.createThread(group, service, [event], route.question, event.createdAt, batchId)
      this.deps.wake()
      return recorded.event
    }
    this.enqueue(group, service, recorded.event, input.mediaGroupId ?? null, humanPriorityUserIds.length > 0)
    return recorded.event
  }

  enrichAttachments(eventId: string, attachments: SupportAttachmentContext[]): SupportMessageEvent {
    const summary = this.attachmentSummary(attachments)
    const current = this.deps.store.getEvent(eventId)
    if (current.attachmentSummary === summary) return current
    const replaced = this.deps.store.replaceEventAttachments(eventId, attachments, summary)
    if (replaced.refreshedThreadIds.length > 0) {
      this.deps.cancelStale?.()
      this.deps.wake()
    }
    return replaced.event
  }

  async drain(): Promise<void> {
    ;[...this.pending.keys()].forEach((batchKey) => this.launch(batchKey))
    while (this.active.size > 0) await Promise.allSettled([...this.active])
  }

  materializePendingBatchForEvent(eventId: string): SupportThread | null {
    const existing = this.deps.store.findThreadByEvent(eventId)
    if (existing) return existing
    const event = this.deps.store.getEvent(eventId)
    if (!event.ingestBatchId) return null
    const batch = [...this.pending.values()].find((candidate) => (
      candidate.id === event.ingestBatchId && candidate.events.some((candidateEvent) => candidateEvent.id === eventId)
    )) ?? this.activeBatches.get(event.ingestBatchId)
    if (!batch || !batch.events.some((candidateEvent) => candidateEvent.id === eventId)) return null
    const combined = batch.events.map((candidateEvent) => {
      const normalized = normalizedEvent(candidateEvent)
      return normalized.safeText || normalized.attachmentSummary
    }).filter(Boolean).join("\n")
    return this.createThread(
      batch.group,
      batch.service,
      batch.events,
      combined,
      addSeconds(batch.events.at(-1)!.createdAt, 30),
      batch.id,
    )
  }

  start(): void {
    if (this.recoveryTimer) return
    this.recover()
    this.recoveryTimer = setInterval(() => this.recover(), 5_000)
    this.recoveryTimer.unref()
  }

  async stop(): Promise<void> {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer)
    this.recoveryTimer = null
    this.pendingPresenceReplies.forEach(({ timer }) => clearTimeout(timer))
    this.pendingPresenceReplies.clear()
    await this.drain()
  }

  recover(): number {
    this.deps.learningSourceObserver?.reconcilePending()
    const recovered = this.deps.store.listUnroutedEvents()
    const batches = new Map<string, Omit<PendingBatch, "timer">>()
    const unassigned = new Map<string, { id: string; latestAt: number }>()
    recovered.forEach((event) => {
      if (this.pendingHasEvent(event.id) || (event.ingestBatchId !== null && this.inFlightBatches.has(event.ingestBatchId))) return
      const group = this.deps.database.readGroups().find((item) => item.id === event.groupId)
      if (!group?.enabled || !group.telegramChatId) {
        this.deps.store.updateEventRoute(event.id, "ignored", "恢复时群配置不可用")
        return
      }
      const route = routeSupportMessage({
        purpose: group.purpose,
        senderRole: event.senderRole,
        canCorrect: false,
        text: event.safeText,
      })
      if (route.action !== "process") {
        this.deps.store.updateEventRoute(event.id, "ignored", "恢复时消息已不满足处理条件")
        return
      }
      if (!route.immediate && group.purpose === "support" && isPresenceCheck(event)) {
        this.schedulePresenceReply(group, event)
        return
      }
      const service = this.resolveService(group, route.requestedService)
      if (!service) {
        this.deps.store.updateEventRoute(event.id, "ignored", "恢复时群未绑定有效服务")
        return
      }
      let batchId = event.ingestBatchId
      if (route.immediate) {
        batchId ??= randomUUID()
        const assigned = this.deps.store.assignEventBatch(event.id, batchId)
        this.createThread(group, service, [assigned], route.question, assigned.createdAt, batchId)
        this.deps.wake()
        return
      }
      if (batchId === null) {
        const conversationKey = event.replyToMessageId
          ? `reply:${event.replyToMessageId}`
          : event.messageThreadId ?? "main"
        const recoveryKey = `${group.id}:${service.id}:${event.senderUserId}:${conversationKey}`
        const previous = unassigned.get(recoveryKey)
        const createdAt = Date.parse(event.createdAt)
        batchId = previous && createdAt - previous.latestAt <= this.batchWindowMs()
          ? previous.id
          : randomUUID()
        unassigned.set(recoveryKey, { id: batchId, latestAt: createdAt })
      }
      const assigned = this.deps.store.assignEventBatch(event.id, batchId)
      const batch = batches.get(batchId)
      if (batch) batch.events.push(assigned)
      else batches.set(batchId, { id: batchId, group, service, events: [assigned] })
    })
    batches.forEach((batch) => {
      if (!this.inFlightBatches.has(batch.id)) this.dispatchBatch(batch)
    })
    return recovered.length
  }

  private enqueue(
    group: RuntimeGroup,
    service: ProjectServiceRecord,
    event: SupportMessageEvent,
    mediaGroupId: string | null,
    launchImmediately = false,
  ): void {
    const conversationKey = mediaGroupId ? `media:${mediaGroupId}`
      : event.replyToMessageId ? `reply:${event.replyToMessageId}`
        : event.messageThreadId ?? "main"
    const batchKey = `${group.id}:${service.id}:${event.senderUserId}:${conversationKey}`
    const current = this.pending.get(batchKey)
    if (current) {
      if (event.ingestBatchId !== null && event.ingestBatchId !== current.id) {
        this.dispatchBatch({ id: event.ingestBatchId, group, service, events: [event] })
        return
      }
      clearTimeout(current.timer)
      current.events.push(this.deps.store.assignEventBatch(event.id, current.id))
      current.timer = setTimeout(() => this.launch(batchKey), this.batchWindowMs())
      current.timer.unref()
      this.deps.store.updateEventRoute(event.id, "batched")
      if (launchImmediately) this.launch(batchKey)
      return
    }
    const timer = setTimeout(() => this.launch(batchKey), this.batchWindowMs())
    timer.unref()
    const id = event.ingestBatchId ?? randomUUID()
    this.pending.set(batchKey, { id, group, service, events: [this.deps.store.assignEventBatch(event.id, id)], timer })
    this.deps.store.updateEventRoute(event.id, "batched")
    if (launchImmediately) this.launch(batchKey)
  }

  private launch(batchKey: string): void {
    const batch = this.pending.get(batchKey)
    if (!batch) return
    clearTimeout(batch.timer)
    this.pending.delete(batchKey)
    this.dispatchBatch(batch)
  }

  private dispatchBatch(batch: Omit<PendingBatch, "timer">): void {
    if (this.inFlightBatches.has(batch.id)) return
    this.inFlightBatches.add(batch.id)
    this.activeBatches.set(batch.id, batch)
    const groupId = batch.group.id
    const previous = this.routeChains.get(groupId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.routeBatch(batch)).finally(() => {
      this.deps.learningSourceObserver?.reconcilePending()
    })
    this.routeChains.set(groupId, current)
    this.track(current.finally(() => {
      this.inFlightBatches.delete(batch.id)
      this.activeBatches.delete(batch.id)
      if (this.routeChains.get(groupId) === current) this.routeChains.delete(groupId)
    }))
  }

  private pendingHasEvent(eventId: string): boolean {
    return [...this.pending.values()].some((batch) => batch.events.some((event) => event.id === eventId))
  }

  private schedulePresenceReply(group: RuntimeGroup, event: SupportMessageEvent): void {
    if (this.pendingPresenceReplies.has(event.id)) return
    const dueAt = Date.parse(event.createdAt) + presenceReplyDelayMs
    const timer = setTimeout(() => {
      const scheduled = this.pendingPresenceReplies.get(event.id)
      if (!scheduled || scheduled.timer !== timer) return
      const task = this.sendPresenceReply(event).finally(() => {
        if (this.pendingPresenceReplies.get(event.id)?.timer === timer) {
          this.pendingPresenceReplies.delete(event.id)
        }
      })
      this.track(task)
    }, Math.max(0, dueAt - Date.now()))
    timer.unref()
    this.pendingPresenceReplies.set(event.id, { groupId: group.id, timer })
  }

  private cancelPresenceRepliesAnsweredByHuman(groupId: string, respondedAt: string): void {
    this.deps.store.listUnroutedEvents().forEach((event) => {
      if (event.groupId !== groupId || event.createdAt > respondedAt || !isPresenceCheck(event)) return
      const pending = this.pendingPresenceReplies.get(event.id)
      if (pending) clearTimeout(pending.timer)
      this.pendingPresenceReplies.delete(event.id)
      this.deps.store.updateEventRoute(event.id, "ignored", "群内人工已回应在线确认")
    })
  }

  private async sendPresenceReply(event: SupportMessageEvent): Promise<void> {
    const current = this.deps.store.getEvent(event.id)
    if (current.routeStatus !== "received" || !isPresenceCheck(current)) return
    const humanResponse = this.deps.database.prepare(`SELECT 1 FROM support_message_events
      WHERE group_id=? AND id<>? AND sender_role IS NOT NULL AND route_status='role_skipped' AND created_at>=?
      ORDER BY created_at,id LIMIT 1`).get(current.groupId, current.id, current.createdAt)
    if (humanResponse) {
      this.deps.store.updateEventRoute(current.id, "ignored", "群内人工已回应在线确认")
      return
    }
    const ownership = this.deps.database.prepare(`SELECT delivery_status FROM telegram_output_ownership
      WHERE delivery_group_id=? AND reply_to_message_id=? AND output_kind='presence_reply'
      ORDER BY created_at DESC,id DESC LIMIT 1`).get(current.groupId, current.telegramMessageId) as
      | { delivery_status: "sending" | "sent" | "failed" | "unknown" }
      | undefined
    if (ownership) {
      this.deps.store.updateEventRoute(
        current.id,
        ownership.delivery_status === "failed" ? "ignored" : "routed",
        ownership.delivery_status === "failed" ? "在线确认快捷回复发送失败" : "在线确认快捷回复已进入发送链路",
      )
      return
    }
    const group = this.deps.database.readGroups().find((candidate) => (
      candidate.id === current.groupId && candidate.enabled && candidate.purpose === "support" && candidate.telegramChatId
    ))
    if (!group || group.operationMode === "learning" || !this.deps.sendPresenceReply) {
      this.deps.store.updateEventRoute(current.id, "ignored", "在线确认快捷回复发送条件不可用")
      return
    }
    try {
      await this.deps.sendPresenceReply({ group, event: current, text: operatorCopy.presence })
      this.deps.store.updateEventRoute(current.id, "routed", "已发送在线确认快捷回复")
    } catch {
      this.deps.store.updateEventRoute(current.id, "ignored", "在线确认快捷回复发送失败")
    }
  }

  private batchWindowMs(): number {
    return Math.max(0, Math.min(300_000, Math.trunc(this.resolveBatchWindowMs())))
  }

  private async routeBatch(batch: Omit<PendingBatch, "timer">): Promise<void> {
    const routeEvents = batch.events.map(normalizedEvent)
    const combined = routeEvents.map((event) => event.safeText || event.attachmentSummary).filter(Boolean).join("\n")
    const batchOwner = this.deps.store.findThreadByBatch(batch.id)
    if (batchOwner) {
      this.assertBatchOwner(batch, batchOwner)
      for (const event of batch.events) {
        const appended = this.deps.store.appendMessageWithSenderFocus({
          threadId: batchOwner.id,
          eventId: event.id,
          relation: batchOwner.status === "answered" || batchOwner.status === "escalated" || batchOwner.status === "closed"
            ? "reopen"
            : "supplement",
          questionFragment: originalQuestionFragment(event, combined),
          settleAt: addSeconds(batch.events.at(-1)!.createdAt, 30),
        }, {
          senderUserId: event.senderUserId,
          source: "new_thread",
          operatorMessageId: event.telegramMessageId,
        })
        if (!appended) throw new Error("恢复批次无法补入原客服记录")
      }
      this.deps.cancelStale?.()
      this.deps.wake()
      return
    }
    const replyTargets = new Map(batch.events.flatMap((event) => {
      if (!event.replyToMessageId) return []
      const target = this.deps.store.findActiveThreadByTelegramMessage(
        batch.group.id, batch.service.id, event.replyToMessageId,
      )
      return target ? [[target.id, target] as const] : []
    }))
    if (replyTargets.size === 1) {
      const target = [...replyTargets.values()][0]!
      const targetDetail = this.deps.store.getThreadDetail(target.id)
      const effectDecision = await this.routeDecision(batch, routeEvents, {
        summary: target.summary,
        recentMessages: targetDetail.messages.slice(-6).map((message) => ({
          sender: "operator" as const,
          text: message.event.safeText || message.event.attachmentSummary,
          createdAt: message.event.createdAt,
        })),
      }, null, null, "classify")
      if (effectDecision?.action === "follow_up" && effectDecision.investigationEffect === "status_only") {
        const appended = this.appendStatusOnlyBatchToThread(
          target.id,
          batch.events,
          effectDecision.questionFragment || combined,
          "explicit_reply",
        )
        if (appended) {
          await this.sendStatusOnlyUpdate(batch, appended, effectDecision.progressReply, batch.events)
          return
        }
      }
      const first = batch.events[0]!
      const firstAppend = this.deps.store.appendMessageWithSenderFocus({
        threadId: target.id,
        eventId: first.id,
        relation: target.status === "answered" || target.status === "escalated" ? "reopen" : "supplement",
        questionFragment: originalQuestionFragment(first, combined),
        settleAt: addSeconds(batch.events.at(-1)!.createdAt, 30),
        expectedRevision: target.revision,
      }, {
        senderUserId: first.senderUserId,
        source: "explicit_reply",
        operatorMessageId: first.telegramMessageId,
      })
      if (firstAppend) {
        batch.events.slice(1).forEach((event) => this.deps.store.appendMessageWithSenderFocus({
          threadId: target.id,
          eventId: event.id,
          relation: "supplement",
          questionFragment: originalQuestionFragment(event, combined),
          settleAt: addSeconds(batch.events.at(-1)!.createdAt, 30),
        }, {
          senderUserId: event.senderUserId,
          source: "explicit_reply",
          operatorMessageId: event.telegramMessageId,
        }))
        this.deps.cancelStale?.()
        this.deps.wake()
        return
      }
    }
    const clarificationTarget = batch.events.every((event) => !event.replyToMessageId)
      ? this.deps.store.findUniqueMinimalClarificationThread(
        batch.group.id,
        batch.service.id,
        batch.events[0]!.senderUserId,
      )
      : null
    if (clarificationTarget) {
      const first = batch.events[0]!
      const firstAppend = this.deps.store.appendMessageWithSenderFocus({
        threadId: clarificationTarget.id,
        eventId: first.id,
        relation: clarificationTarget.status === "answered" || clarificationTarget.status === "escalated"
          ? "reopen"
          : "supplement",
        questionFragment: originalQuestionFragment(first, combined),
        settleAt: addSeconds(batch.events.at(-1)!.createdAt, 30),
        expectedRevision: clarificationTarget.revision,
      }, {
        senderUserId: first.senderUserId,
        source: "clarification_answer",
        operatorMessageId: first.telegramMessageId,
      })
      if (firstAppend) {
        batch.events.slice(1).forEach((event) => this.deps.store.appendMessageWithSenderFocus({
          threadId: clarificationTarget.id,
          eventId: event.id,
          relation: "supplement",
          questionFragment: originalQuestionFragment(event, combined),
          settleAt: addSeconds(batch.events.at(-1)!.createdAt, 30),
        }, {
          senderUserId: event.senderUserId,
          source: "clarification_answer",
          operatorMessageId: event.telegramMessageId,
        }))
        this.deps.cancelStale?.()
        this.deps.wake()
        return
      }
    }
    const unresolvedReplyReferences = new Map<string, {
      event: SupportMessageEvent | null
      thread: SupportThread | null
      text: string
    }>()
    for (const event of batch.events) {
      if (!event.replyToMessageId) continue
      const referencedEvent = this.deps.store.getEventByTelegramMessage(batch.group.id, event.replyToMessageId)
      const eventThread = referencedEvent ? this.deps.store.findThreadByEvent(referencedEvent.id) : null
      const botThread = referencedEvent ? null : this.deps.store.findThreadByBotReplyMessage(
        batch.group.id,
        event.replyToMessageId,
      )
      const referencedThread = eventThread ?? botThread
      const activeSameService = referencedThread && referencedThread.status !== "closed"
        && referencedThread.serviceId === batch.service.id
      if (activeSameService) continue
      const text = referencedEvent
        ? referencedEvent.safeText.trim() || referencedEvent.attachmentSummary.trim()
        : referencedThread?.summary.trim() || ""
      if (!text) continue
      unresolvedReplyReferences.set(event.replyToMessageId, {
        event: referencedEvent,
        thread: referencedThread,
        text,
      })
    }
    if (unresolvedReplyReferences.size === 1) {
      const reference = [...unresolvedReplyReferences.values()][0]!
      const context = [reference.text, combined].filter(Boolean).join("\n")
      const attachReferencedEvent = reference.event !== null
        && reference.thread === null
        && reference.event.senderRole === null
        && !batch.events.some((event) => event.id === reference.event!.id)
      this.createThread(
        batch.group,
        batch.service,
        attachReferencedEvent ? [reference.event!, ...batch.events] : batch.events,
        context,
        addSeconds(batch.events.at(-1)!.createdAt, 30),
        batch.id,
        attachReferencedEvent ? undefined : context,
      )
      this.deps.wake()
      return
    }
    this.deps.cancelStale?.()
    const senderUserId = batch.events[0]!.senderUserId
    const latestEvent = batch.events.at(-1)!
    const settleAt = addSeconds(latestEvent.createdAt, 30)
    const pending = this.deps.store.getPendingRouteClarification(
      batch.group.id, batch.service.id, senderUserId, latestEvent.createdAt,
    )
    if (pending) {
      const decision = await this.routeDecision(batch, routeEvents, null, {
        latestQuestion: combined,
        candidateLabels: pending.candidateLabels,
      }, null, "resolve_clarification")
      if (!decision) return
      if (decision.action === "candidate_1" || decision.action === "candidate_2") {
        const selectedCandidate = decision.action === "candidate_1" ? 1 : 2
        const resolved = this.deps.store.resolveRouteClarification({
          clarificationId: pending.id,
          answerEventId: batch.events[0]!.id,
          selectedCandidate,
          settleAt,
        })
        if (resolved) {
          for (const event of batch.events.slice(1)) {
            this.deps.store.appendMessageWithSenderFocus({
              threadId: resolved.id,
              eventId: event.id,
              relation: "supplement",
              questionFragment: originalQuestionFragment(event, decision.questionFragment || combined),
              settleAt,
            }, {
              senderUserId,
              source: "clarification_answer",
              operatorMessageId: event.telegramMessageId,
            })
          }
          this.deps.cancelStale?.()
          this.deps.wake()
        }
        return
      }
      if (decision.action === "new_thread") {
        this.deps.store.cancelPendingRouteClarification(
          batch.group.id, batch.service.id, senderUserId, latestEvent.createdAt,
        )
        this.deps.store.updateEventRoute(pending.messageEventId, "ignored", "运营提出独立新问题，待归属确认已取消")
        this.createThread(batch.group, batch.service, batch.events, decision.questionFragment || combined, settleAt, batch.id)
        this.deps.wake()
        return
      }
      if (decision.action === "uncertain" && decision.clarificationReply
        && batch.group.operationMode !== "learning" && this.deps.sendRouteClarification) {
        try {
          const sent = await this.deps.sendRouteClarification({
            group: batch.group, service: batch.service, event: latestEvent, clarification: pending,
            text: decision.clarificationReply,
          })
          this.deps.store.markRouteClarificationPrompt(pending.id, sent.replyId, latestEvent.createdAt)
        } catch { /* 普通客服回复失败时保持静默，不生成代码兜底。 */ }
        return
      }
      batch.events.forEach((event) => this.deps.store.updateEventRoute(event.id, "ignored", "待归属回答未选择合法候选"))
      return
    }

    const focus = this.deps.store.getSenderFocus(
      batch.group.id, batch.service.id, senderUserId, latestEvent.createdAt,
    )
    const senderCandidates = this.deps.store.listSenderRouteCandidates(
      batch.group.id, batch.service.id, senderUserId, 2, latestEvent.createdAt,
    )
    const focusContext = focus ? {
      summary: this.deps.store.getThread(focus.threadId).summary,
      recentMessages: this.deps.store.getThreadDetail(focus.threadId).messages.slice(-6).map((message) => ({
        sender: "operator" as const,
        text: message.event.safeText || message.event.attachmentSummary,
        createdAt: message.event.createdAt,
      })),
    } : null
    const ambiguityContext = senderCandidates.length === 2 ? {
      latestQuestion: combined,
      candidateLabels: senderCandidates.map((candidate) => candidate.label),
    } : null
    const decision = await this.routeDecision(batch, routeEvents, focusContext, null, ambiguityContext, "classify")
    if (!decision) return
    const question = decision.questionFragment || combined
    if (decision.action === "split") {
      try {
        this.createSplitThreads(batch.group, batch.service, batch.events, decision, settleAt, batch.id)
      } catch {
        this.createThread(batch.group, batch.service, batch.events, combined, settleAt, batch.id)
      }
      this.deps.cancelStale?.()
      this.deps.wake()
      return
    }
    if (decision.action === "idle") {
      batch.events.forEach((event) => this.deps.store.updateEventRoute(event.id, "ignored", "明确闲聊或无需客服介入"))
      return
    }
    if (decision.action === "follow_up" && focus) {
      if (decision.investigationEffect === "status_only") {
        const appended = this.appendStatusOnlyBatchToThread(
          focus.threadId,
          batch.events,
          question,
          "operator_reply",
        )
        if (appended) {
          await this.sendStatusOnlyUpdate(batch, appended, decision.progressReply, batch.events)
          return
        }
      }
      const appended = this.appendBatchToThread(focus.threadId, batch.events, question, settleAt, "operator_reply")
      if (appended) {
        this.deps.cancelStale?.()
        this.deps.wake()
      }
      return
    }
    if (decision.action === "uncertain" && senderCandidates.length === 2
      && batch.events.length === 1 && decision.clarificationReply) {
      const clarification = this.deps.store.createRouteClarification({
        groupId: batch.group.id,
        serviceId: batch.service.id,
        senderUserId,
        messageEventId: latestEvent.id,
        candidates: senderCandidates.map((candidate) => ({
          threadId: candidate.thread.id,
          label: candidate.label,
        })),
        createdAt: latestEvent.createdAt,
      })
      if (batch.group.operationMode !== "learning" && this.deps.sendRouteClarification) {
        try {
          const sent = await this.deps.sendRouteClarification({
            group: batch.group, service: batch.service, event: latestEvent, clarification,
            text: decision.clarificationReply,
          })
          this.deps.store.markRouteClarificationPrompt(clarification.id, sent.replyId, latestEvent.createdAt)
        } catch {
          this.deps.store.cancelPendingRouteClarification(
            batch.group.id, batch.service.id, senderUserId, latestEvent.createdAt,
          )
          this.deps.store.updateEventRoute(latestEvent.id, "ignored", "待归属确认发送失败")
        }
      } else {
        this.deps.store.cancelPendingRouteClarification(
          batch.group.id, batch.service.id, senderUserId, latestEvent.createdAt,
        )
        this.deps.store.updateEventRoute(latestEvent.id, "ignored", "待归属确认发送失败")
      }
      return
    }
    if (decision.action === "candidate_1" || decision.action === "candidate_2") {
      this.createThread(batch.group, batch.service, batch.events, question, settleAt, batch.id)
      this.deps.wake()
      return
    }
    this.deps.store.cancelPendingRouteClarification(
      batch.group.id, batch.service.id, senderUserId, latestEvent.createdAt,
    )
    this.createThread(batch.group, batch.service, batch.events, question, settleAt, batch.id)
    this.deps.wake()
  }

  private createThread(
    group: RuntimeGroup,
    service: ProjectServiceRecord,
    events: SupportMessageEvent[],
    question: string,
    settleAt: string,
    originBatchId: string,
    originQuestionFragment?: string,
  ): SupportThread {
    const first = events[0]!
    const result = this.deps.store.createThreadWithSenderFocus({
      groupId: group.id,
      projectId: service.projectId,
      serviceId: service.id,
      originBatchId,
      settleAt,
      anchorMessageId: first.telegramMessageId,
      latestMessageAt: events.at(-1)!.createdAt,
      summary: question,
      originEventId: first.id,
      questionFragment: originQuestionFragment ?? originalQuestionFragment(first, question),
    }, {
      senderUserId: first.senderUserId,
      source: "new_thread",
      operatorMessageId: first.telegramMessageId,
    })
    const remainingEvents = result.created ? events.slice(1) : events
    for (const event of remainingEvents) {
      const appended = this.deps.store.appendMessageWithSenderFocus({
        threadId: result.thread.id,
        eventId: event.id,
        relation: "supplement",
        questionFragment: originalQuestionFragment(event, question),
        settleAt,
      }, {
        senderUserId: event.senderUserId,
        source: "new_thread",
        operatorMessageId: event.telegramMessageId,
      })
      if (!appended) throw new Error("接收批次无法完整归入客服记录")
    }
    if (!result.created) this.deps.cancelStale?.()
    return this.deps.store.getThread(result.thread.id)
  }

  private createSplitThreads(
    group: RuntimeGroup,
    service: ProjectServiceRecord,
    events: SupportMessageEvent[],
    decision: ThreadRouteResult,
    settleAt: string,
    originBatchId: string,
  ): SupportThread[] {
    const issues = decision.issues ?? []
    if (decision.action !== "split" || issues.length < 2) throw new Error("拆分路由缺少问题单元")
    const eventsById = new Map(events.map((event) => [event.id, event]))
    const covered = new Set(issues.flatMap((issue) => issue.eventIds))
    if (issues.some((issue) => issue.eventIds.some((eventId) => !eventsById.has(eventId)))
      || events.some((event) => !covered.has(event.id))) {
      throw new Error("拆分路由与当前接收批次不一致")
    }
    return this.deps.database.transaction(() => {
      const created = issues.map((issue, issueIndex) => {
        const issueEvents = [...new Set(issue.eventIds)]
          .map((eventId) => eventsById.get(eventId)!)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
            || left.telegramMessageId.localeCompare(right.telegramMessageId))
        const first = issueEvents[0]!
        const result = this.deps.store.createThreadWithSenderFocus({
          groupId: group.id,
          projectId: service.projectId,
          serviceId: service.id,
          originBatchId: issueIndex === 0 ? originBatchId : randomUUID(),
          settleAt,
          anchorMessageId: first.telegramMessageId,
          latestMessageAt: issueEvents.at(-1)!.createdAt,
          summary: issue.questionFragment,
          originEventId: first.id,
          questionFragment: issue.questionFragment,
        }, {
          senderUserId: first.senderUserId,
          source: "new_thread",
          operatorMessageId: first.telegramMessageId,
        })
        for (const event of issueEvents.slice(1)) {
          const appended = this.deps.store.appendMessageWithSenderFocus({
            threadId: result.thread.id,
            eventId: event.id,
            relation: "supplement",
            questionFragment: issue.questionFragment,
            settleAt,
          }, {
            senderUserId: event.senderUserId,
            source: "new_thread",
            operatorMessageId: event.telegramMessageId,
          })
          if (!appended) throw new Error("拆分问题无法完整写入客服记录")
        }
        return this.deps.store.getThread(result.thread.id)
      })
      const root = created[0]!
      created.slice(1).forEach((thread) => this.deps.store.linkSplitThread(
        root.id,
        thread.id,
        decision.reason,
      ))
      return created
    })
  }

  private appendBatchToThread(
    threadId: string,
    events: SupportMessageEvent[],
    question: string,
    settleAt: string,
    source: "operator_reply" | "explicit_reply" | "clarification_answer",
  ): SupportThread | null {
    let current = this.deps.store.getThread(threadId)
    for (const [index, event] of events.entries()) {
      const appended = this.deps.store.appendMessageWithSenderFocus({
        threadId,
        eventId: event.id,
        relation: current.status === "answered" || current.status === "escalated" ? "reopen" : "supplement",
        questionFragment: originalQuestionFragment(event, question),
        settleAt,
        ...(index === 0 ? { expectedRevision: current.revision } : {}),
      }, {
        senderUserId: event.senderUserId,
        source,
        operatorMessageId: event.telegramMessageId,
      })
      if (!appended) return null
      current = appended
    }
    return current
  }

  private appendStatusOnlyBatchToThread(
    threadId: string,
    events: SupportMessageEvent[],
    question: string,
    source: "operator_reply" | "explicit_reply",
  ): SupportThread | null {
    let current = this.deps.store.getThread(threadId)
    if (current.status !== "collecting" && current.status !== "generating") return null
    for (const [index, event] of events.entries()) {
      const appended = this.deps.store.appendStatusOnlyMessageWithSenderFocus({
        threadId,
        eventId: event.id,
        relation: "supplement",
        questionFragment: originalQuestionFragment(event, question),
        settleAt: current.settleAt,
        ...(index === 0 ? { expectedRevision: current.revision } : {}),
      }, {
        senderUserId: event.senderUserId,
        source,
        operatorMessageId: event.telegramMessageId,
      })
      if (!appended) return null
      current = appended
    }
    return current
  }

  private async sendStatusOnlyUpdate(
    batch: Omit<PendingBatch, "timer">,
    thread: SupportThread,
    text: string | null | undefined,
    events: SupportMessageEvent[],
  ): Promise<void> {
    const latestEvent = events.at(-1)!
    let reason = "仅询问当前排查进度，不改变排查输入"
    try {
      if (thread.answerOperationMode !== "learning" && text && this.deps.sendStatusUpdate) {
        await this.deps.sendStatusUpdate({
          group: batch.group,
          service: batch.service,
          thread,
          event: latestEvent,
          text,
        })
        reason = "仅询问当前排查进度，已由当班客服回复且不改变排查输入"
      }
    } catch {
      reason = "仅询问当前排查进度，进度回复发送失败但不改变排查输入"
    } finally {
      events.forEach((event) => this.deps.store.updateEventRoute(event.id, "routed", reason))
    }
  }

  private async routeDecision(
    batch: Omit<PendingBatch, "timer">,
    messages: SupportMessageEvent[],
    focus: SenderRouteFocusContext | null,
    pending: SenderRoutePendingContext | null,
    ambiguity: SenderRoutePendingContext | null,
    mode: "classify" | "resolve_clarification",
  ): Promise<ThreadRouteResult | null> {
    let decision: ThreadRouteResult
    try {
      decision = await this.deps.router.route({
        mode,
        group: batch.group,
        service: batch.service,
        messages,
        focus,
        pending,
        ambiguity,
      })
    } catch {
      return {
        action: "new_thread",
        questionFragment: messages.map((message) => originalQuestionFragment(message, message.safeText)).join("\n").trim(),
        reason: "路由模型失败，按独立问题安全接收，避免消息丢失或误归到其他线程",
        confidence: 0,
        clarificationReply: null,
      }
    }
    const materializedDuringRoute = this.deps.store.findThreadByBatch(batch.id)
    if (materializedDuringRoute) {
      this.assertBatchOwner(batch, materializedDuringRoute)
      this.deps.wake()
      return null
    }
    return decision
  }

  private assertBatchOwner(batch: Omit<PendingBatch, "timer">, thread: SupportThread): void {
    if (thread.groupId !== batch.group.id
      || thread.projectId !== batch.service.projectId
      || thread.serviceId !== batch.service.id) {
      throw new Error("接收批次已归入不匹配的群或服务")
    }
  }

  private resolveService(group: RuntimeGroup, requestedService: string | null): ProjectServiceRecord | undefined {
    if (!requestedService) {
      return group.serviceId
        ? this.deps.database.readProjectServices("WHERE id=? AND enabled=1", [group.serviceId])[0]
        : undefined
    }
    const needle = normalizeService(requestedService)
    const matches = this.deps.database.readProjectServices("WHERE enabled=1").filter((service) => (
      [service.key, service.name].some((value) => normalizeService(value) === needle)
      && (!group.projectId || service.projectId === group.projectId)
    ))
    return matches.length === 1 ? matches[0] : undefined
  }

  private attachmentSummary(attachments: SupportAttachmentContext[]): string {
    return attachments.map((attachment) => [
      `${attachment.name}（${attachment.kind}）`,
      attachment.extractedText,
    ].filter(Boolean).join("\n")).join("\n\n")
  }

  private track(task: Promise<void>): void {
    const guarded = task.catch(() => undefined)
    this.active.add(guarded)
    void guarded.finally(() => this.active.delete(guarded))
  }
}
