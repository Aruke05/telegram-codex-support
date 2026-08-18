import { createHash, randomUUID } from "node:crypto"

import { z } from "zod"

import { redactText, type ConfiguredSecretRedactor } from "../security/dlp.js"
import { systemDirectiveSeeds } from "../support/system-directives.js"
import type { RuntimeDatabase } from "./database.js"
import {
  memoryEventTypeSchema,
  memoryRiskSchema,
  memoryStatusSchema,
  type Directive,
  type MemoryEvent,
  type MemoryEventType,
  type MemoryFact,
  type MemoryRisk,
  type MemoryStatus,
  type MemoryVersion,
  type MemoryView,
  type ReplyRecord,
} from "./types.js"

const metadataValue = (max: number) => z.string().trim().min(1).max(max).transform((value) => sanitize(value)).pipe(z.string().min(1).max(max))
const nullableScopeValue = metadataValue(120).nullable()
const baseMemoryInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(12000),
  scope: metadataValue(120),
  region: nullableScopeValue,
  branch: nullableScopeValue,
  risk: memoryRiskSchema,
  confidence: z.number().min(0).max(1),
  actor: metadataValue(160),
}).strict()

const createMemorySchema = baseMemoryInputSchema.extend({
  source: z.literal("human_rule"),
}).strict()

const observationSchema = baseMemoryInputSchema.extend({
  evidenceType: memoryEventTypeSchema,
  codeRevision: metadataValue(160).nullable().optional(),
  sourceRef: metadataValue(240).nullable().optional(),
}).strict()

const referenceObservationSchema = baseMemoryInputSchema.extend({
  action: z.enum(["add", "reinforce", "conflict"]),
  observationIds: z.array(z.string().uuid()).min(1).max(50),
  snapshotId: z.string().uuid().nullable(),
  codeRevision: metadataValue(160).nullable(),
  codeEvidencePaths: z.array(z.string().trim().min(1).max(500)).max(10),
}).strict().superRefine((value, context) => {
  if (value.codeEvidencePaths.length > 0 && (!value.snapshotId || !value.codeRevision)) {
    context.addIssue({ code: "custom", path: ["codeEvidencePaths"], message: "代码证据缺少当前快照标识" })
  }
})

const directiveInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(12000),
  scope: metadataValue(120),
  source: z.literal("human").default("human"),
  priority: z.number().int().min(1).max(100).default(80),
  actor: metadataValue(160),
}).strict()

const directiveUpdateInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(12000),
  scope: metadataValue(120),
  priority: z.number().int().min(1).max(100),
  actor: metadataValue(160),
}).strict()

const replyInputSchema = z.object({
  groupId: z.string().uuid().nullable(),
  accountId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable().default(null),
  serviceId: z.string().uuid().nullable().default(null),
  telegramMessageId: metadataValue(80).nullable(),
  telegramReplyMessageId: metadataValue(80).nullable(),
  service: metadataValue(120),
  question: z.string().trim().min(1).max(12000),
  answer: z.string().max(12000),
  quote: z.string().max(1000).nullable(),
  decision: z.enum(["reply", "ignore", "escalate"]),
  memoryVersionRefs: z.array(z.string().uuid()),
  codeRevision: metadataValue(160).nullable(),
}).strict()

const correctionInputSchema = z.object({
  correctedAnswer: z.string().trim().min(1).max(12000),
  reason: z.string().trim().min(1).max(1000),
  title: z.string().trim().min(1).max(160).optional(),
  memoryContent: z.string().trim().min(1).max(12000).optional(),
  scope: metadataValue(120),
  region: nullableScopeValue,
  branch: nullableScopeValue,
  correctedBy: metadataValue(160),
}).strict()

const standaloneCorrectionInputSchema = correctionInputSchema.extend({
  originalQuestion: z.string().trim().min(1).max(12000),
  previousAnswer: z.string().max(12000),
  referencedMemoryIds: z.array(z.string().uuid()).default([]),
  codeRevision: metadataValue(160).nullable(),
  sourceRef: metadataValue(200),
}).strict()

export type CreateMemoryInput = z.input<typeof createMemorySchema>
export type ObservationInput = z.input<typeof observationSchema>
export type ReferenceObservationInput = z.input<typeof referenceObservationSchema>
export type DirectiveInput = z.input<typeof directiveInputSchema>
export type DirectiveUpdateInput = z.input<typeof directiveUpdateInputSchema>
export type ReplyInput = z.input<typeof replyInputSchema>
export type CorrectionInput = z.input<typeof correctionInputSchema>
export type MemoryEvidenceSummary = {
  codeEvidence: Array<{ path: string; codeRevision: string | null; snapshotId: string }>
  sourceThreads: Array<{ observationId: string; threadId: string }>
}
export type StandaloneCorrectionInput = z.input<typeof standaloneCorrectionInputSchema>

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN")
}

function normalizeReferenceRule(value: string): string {
  return value.trim().replace(/\s+/gu, " ")
}

const memoryRiskRank: Record<MemoryRisk, number> = { low: 0, medium: 1, high: 2 }

function ftsTrigramQuery(value: string): string | null {
  const characters = [...normalize(value).replace(/[^\p{L}\p{N}]+/gu, "")]
  if (characters.length < 3) return null
  const terms = new Set<string>()
  for (let index = 0; index <= characters.length - 3 && terms.size < 48; index += 1) {
    terms.add(characters.slice(index, index + 3).join(""))
  }
  return [...terms].map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ") || null
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function sanitize(value: string): string {
  return redactText(value).text.trim()
}

function topicKey(input: Pick<CreateMemoryInput, "title" | "scope" | "region" | "branch">): string {
  return sha256([input.scope, input.region ?? "*", input.branch ?? "*", normalize(input.title)].join("|"))
}

function eventFor(input: {
  type: MemoryEventType
  content: string
  factId: string | null
  replyRecordId?: string | null
  sourceRef?: string | null
  scope: string
  region: string | null
  branch: string | null
  codeRevision?: string | null
  risk: MemoryRisk
  confidence: number
  actor: string
  occurredAt: string
}): MemoryEvent {
  return {
    id: randomUUID(),
    type: input.type,
    sourceRef: input.sourceRef ?? null,
    factId: input.factId,
    replyRecordId: input.replyRecordId ?? null,
    content: input.content,
    scope: input.scope,
    region: input.region,
    branch: input.branch,
    codeRevision: input.codeRevision ?? null,
    risk: input.risk,
    confidence: input.confidence,
    actor: input.actor,
    occurredAt: input.occurredAt,
  }
}

export class RuntimeKnowledgeService {
  constructor(
    readonly database: RuntimeDatabase,
    private readonly configuredRedactor?: ConfiguredSecretRedactor,
  ) {}

  private sanitize(value: string): string {
    return (this.configuredRedactor?.redact(value) ?? redactText(value)).text.trim()
  }

  ensureSystemDirectives(): void {
    const existing = this.database.readDirectives("WHERE source='system' ORDER BY priority DESC, title")
    const exact = existing.length === systemDirectiveSeeds.length && systemDirectiveSeeds.every((seed) => existing.some((item) => (
      item.title === seed.title && item.content === seed.content && item.scope === "global"
      && item.priority === seed.priority && item.enabled && item.disabledAt === null
    )))
    if (exact) return
    const now = new Date().toISOString()
    this.database.transaction(() => {
      const directives = systemDirectiveSeeds.map((seed): Directive => ({
          id: randomUUID(), title: seed.title, content: seed.content, scope: "global", source: "system",
          priority: seed.priority, enabled: true, createdAt: now, disabledAt: null,
      }))
      this.database.replaceSystemDirectives(directives)
      directives.forEach((directive) => {
        this.database.insertEvent(eventFor({
          type: "human_rule", content: `${directive.title}\n${directive.content}`, factId: null, scope: "global",
          region: null, branch: null, risk: "high", confidence: 1, actor: "system", occurredAt: now,
        }))
      })
      this.database.bumpMemoryGeneration()
    })
  }

  indexStaticKnowledge(documents: Array<{
    source: "magicbook" | "interface_india" | "interface_non_india"
    title: string
    scope: string
    content: string
    capturedAt: string
  }>): void {
    const unsafe = documents.some((document) => [document.title, document.scope, document.content].some((value) => redactText(value).changed))
    if (unsafe) throw new Error("静态知识包含敏感信息")
    const changed = documents.filter((document) => {
      const hash = sha256(document.content)
      const existing = this.database.prepare("SELECT content_hash FROM knowledge_documents WHERE source=?").get(document.source) as { content_hash: string } | undefined
      return existing?.content_hash !== hash
    })
    if (changed.length === 0) return
    const indexedAt = new Date().toISOString()
    this.database.transaction(() => {
      changed.forEach((document) => {
        const id = sha256(`static:${document.source}`)
        const contentHash = sha256(document.content)
        this.database.prepare(`INSERT INTO knowledge_documents(id,source,title,scope,content,content_hash,captured_at,indexed_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET
          title=excluded.title,scope=excluded.scope,content=excluded.content,content_hash=excluded.content_hash,
          captured_at=excluded.captured_at,indexed_at=excluded.indexed_at`).run(
          id, document.source, document.title, document.scope, document.content, contentHash, document.capturedAt, indexedAt,
        )
        this.database.prepare("DELETE FROM knowledge_document_fts WHERE id=?").run(id)
        this.database.prepare("INSERT INTO knowledge_document_fts(id,title,content,scope) VALUES (?,?,?,?)").run(
          id, document.title, document.content, document.scope,
        )
      })
      this.database.bumpMemoryGeneration()
    })
  }

  searchStaticKnowledge(query: string, limit = 8, scope?: "india" | "non_india"): Array<{ source: string; title: string; scope: string; content: string; capturedAt: string }> {
    const match = ftsTrigramQuery(query)
    if (!match) return []
    const scopeClause = scope ? "AND d.scope IN (?, 'global')" : ""
    return this.database.prepare(`SELECT d.source,d.title,d.scope,d.content,d.captured_at AS capturedAt
      FROM knowledge_document_fts f JOIN knowledge_documents d ON d.id=f.id
      WHERE knowledge_document_fts MATCH ? ${scopeClause} ORDER BY bm25(knowledge_document_fts) LIMIT ?`).all(
      match, ...(scope ? [scope] : []), Math.min(Math.max(limit, 1), 20),
    ) as Array<{ source: string; title: string; scope: string; content: string; capturedAt: string }>
  }

  listDirectives(filters: { enabled?: boolean; scope?: string } = {}): Directive[] {
    const clauses: string[] = []
    const parameters: Array<string | number> = []
    if (filters.enabled !== undefined) { clauses.push("enabled=?"); parameters.push(Number(filters.enabled)) }
    if (filters.scope) { clauses.push("scope IN (?, 'global')"); parameters.push(filters.scope) }
    return this.database.readDirectives(`${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY priority DESC, created_at`, parameters)
  }

  async createDirective(input: DirectiveInput): Promise<Directive> {
    const parsed = directiveInputSchema.parse(input)
    const content = this.sanitize(parsed.content)
    const title = this.sanitize(parsed.title)
    if (!title || !content) throw new Error("规则内容脱敏后为空")
    const now = new Date().toISOString()
    const directive: Directive = {
      id: randomUUID(), title, content, scope: parsed.scope, source: parsed.source,
      priority: parsed.priority, enabled: true, createdAt: now, disabledAt: null,
    }
    this.database.transaction(() => {
      this.database.insertDirective(directive)
      this.database.insertEvent(eventFor({
        type: "human_rule", content: `${title}\n${content}`, factId: null, scope: parsed.scope,
        region: null, branch: null, risk: "high", confidence: 1, actor: parsed.actor, occurredAt: now,
      }))
      this.database.bumpMemoryGeneration()
    })
    return directive
  }

  async setDirectiveEnabled(id: string, enabled: boolean, actor: string): Promise<Directive> {
    const found = this.database.readDirectives("WHERE id=?", [id])[0]
    if (!found) throw new Error("固定规则不存在")
    if (found.source === "system") throw new Error("系统固定规则不能修改")
    const now = new Date().toISOString()
    this.database.transaction(() => {
      this.database.prepare("UPDATE directives SET enabled=?,disabled_at=? WHERE id=?").run(Number(enabled), enabled ? null : now, id)
      this.database.insertEvent(eventFor({
        type: "human_rule", content: `${enabled ? "启用" : "停用"}固定规则：${found.title}`, factId: null,
        scope: found.scope, region: null, branch: null, risk: "high", confidence: 1,
        actor: this.sanitize(actor) || "后台管理员", occurredAt: now,
      }))
      this.database.bumpMemoryGeneration()
    })
    return this.database.readDirectives("WHERE id=?", [id])[0] as Directive
  }

  async deleteDirective(id: string, actor: string): Promise<void> {
    const found = this.database.readDirectives("WHERE id=?", [id])[0]
    if (!found) throw new Error("固定规则不存在")
    if (found.source === "system") throw new Error("系统固定规则不能删除")
    const now = new Date().toISOString()
    this.database.transaction(() => {
      this.database.insertEvent(eventFor({
        type: "retraction", content: `删除固定规则：${found.title}`, factId: null,
        scope: found.scope, region: null, branch: null, risk: "high", confidence: 1,
        actor: this.sanitize(actor) || "后台管理员", occurredAt: now,
      }))
      const result = this.database.prepare("DELETE FROM directives WHERE id=? AND source='human'").run(id)
      if (result.changes !== 1) throw new Error("固定规则不存在")
      this.database.bumpMemoryGeneration()
    })
  }

  async updateDirective(id: string, input: DirectiveUpdateInput): Promise<Directive> {
    const parsed = directiveUpdateInputSchema.parse(input)
    const found = this.database.readDirectives("WHERE id=?", [id])[0]
    if (!found) throw new Error("固定规则不存在")
    if (found.source === "system") throw new Error("系统固定规则不能修改")
    const title = this.sanitize(parsed.title)
    const content = this.sanitize(parsed.content)
    if (!title || !content) throw new Error("规则内容脱敏后为空")
    const now = new Date().toISOString()
    this.database.transaction(() => {
      this.database.prepare(`UPDATE directives SET title=?,content=?,scope=?,priority=? WHERE id=?`).run(
        title, content, parsed.scope, parsed.priority, id,
      )
      this.database.insertEvent(eventFor({
        type: "human_rule", content: `编辑固定规则：${title}\n${content}`, factId: null,
        scope: parsed.scope, region: null, branch: null, risk: "high", confidence: 1,
        actor: this.sanitize(parsed.actor) || "后台管理员", occurredAt: now,
      }))
      this.database.bumpMemoryGeneration()
    })
    return this.database.readDirectives("WHERE id=?", [id])[0] as Directive
  }

  async createMemory(input: CreateMemoryInput): Promise<MemoryView> {
    const parsed = createMemorySchema.parse(input)
    const title = this.sanitize(parsed.title)
    const content = this.sanitize(parsed.content)
    if (!title || !content) throw new Error("记忆内容脱敏后为空")
    return this.database.transaction(() => {
      const key = topicKey({ ...parsed, title })
      const existing = this.database.readFacts("WHERE topic_key=?", [key])[0]
      const now = new Date().toISOString()
      const fact: MemoryFact = existing ?? { id: randomUUID(), topicKey: key, title, currentVersionId: null, createdAt: now }
      if (!existing) this.database.insertFact(fact)
      const event = eventFor({
        type: parsed.source, content, factId: fact.id, scope: parsed.scope, region: parsed.region,
        branch: parsed.branch, risk: parsed.risk, confidence: parsed.confidence, actor: parsed.actor, occurredAt: now,
      })
      this.database.insertEvent(event)
      const versions = this.database.readVersions("WHERE fact_id=? ORDER BY version_number DESC", [fact.id])
      this.supersedeActive(fact.id, now)
      const version: MemoryVersion = {
        id: randomUUID(), factId: fact.id, version: (versions[0]?.version ?? 0) + 1, title, content,
        scope: parsed.scope, region: parsed.region, branch: parsed.branch, source: parsed.source,
        risk: parsed.risk, confidence: parsed.confidence, status: "active", conflictReason: null,
        validFrom: now, validTo: null, createdByEventId: event.id, createdAt: now,
      }
      this.database.insertVersion(version, sha256(content))
      this.database.insertVersionEvidence(version.id, event.id)
      this.database.setCurrentVersion(fact.id, version.id)
      this.database.bumpMemoryGeneration()
      return this.getMemory(version.id)
    })
  }

  async submitObservation(input: ObservationInput): Promise<MemoryView> {
    const parsed = observationSchema.parse(input)
    const title = this.sanitize(parsed.title)
    const content = this.sanitize(parsed.content)
    if (!title || !content) throw new Error("记忆内容脱敏后为空")
    return this.database.transaction(() => {
      const key = topicKey({ ...parsed, title })
      const now = new Date().toISOString()
      let fact = this.database.readFacts("WHERE topic_key=?", [key])[0]
      if (!fact) {
        fact = { id: randomUUID(), topicKey: key, title, currentVersionId: null, createdAt: now }
        this.database.insertFact(fact)
      }
      const event = eventFor({
        type: parsed.evidenceType, content, factId: fact.id, sourceRef: parsed.sourceRef ?? null,
        scope: parsed.scope, region: parsed.region, branch: parsed.branch, codeRevision: parsed.codeRevision ?? null,
        risk: parsed.risk, confidence: parsed.confidence, actor: parsed.actor, occurredAt: now,
      })
      this.database.insertEvent(event)
      const contentHash = sha256(content)
      const sameRow = this.database.prepare("SELECT id FROM memory_versions WHERE fact_id=? AND content_hash=? ORDER BY version_number DESC LIMIT 1").get(fact.id, contentHash) as { id: string } | undefined
      if (sameRow) {
        this.database.insertVersionEvidence(sameRow.id, event.id)
        const same = this.getMemory(sameRow.id)
        const eventTypes = this.evidenceTypes(same.id)
        const independentEvidence = this.independentEvidenceCount(same.id)
        const supported = eventTypes.includes("code") || eventTypes.includes("document") || eventTypes.includes("magicbook")
        if (same.status === "candidate" && same.risk === "low" && parsed.risk === "low" && independentEvidence >= 3 && supported) {
          this.supersedeActive(fact.id, now)
          this.database.prepare("UPDATE memory_versions SET status='active',conflict_reason=NULL WHERE id=?").run(same.id)
          this.database.setCurrentVersion(fact.id, same.id)
          this.database.bumpMemoryGeneration()
        }
        return this.getMemory(same.id)
      }

      const versions = this.database.readVersions("WHERE fact_id=? ORDER BY version_number DESC", [fact.id])
      const hasDifferentConclusion = versions.length > 0
      const status: MemoryStatus = hasDifferentConclusion ? "conflict" : "candidate"
      const version: MemoryVersion = {
        id: randomUUID(), factId: fact.id, version: (versions[0]?.version ?? 0) + 1, title, content,
        scope: parsed.scope, region: parsed.region, branch: parsed.branch, source: parsed.evidenceType,
        risk: parsed.risk, confidence: parsed.confidence, status,
        conflictReason: hasDifferentConclusion ? "同一主题存在不同结论，已保留双方证据" : null,
        validFrom: now, validTo: null, createdByEventId: event.id, createdAt: now,
      }
      this.database.insertVersion(version, contentHash)
      this.database.insertVersionEvidence(version.id, event.id)
      this.database.bumpMemoryGeneration()
      return this.getMemory(version.id)
    })
  }

  submitReferenceObservation(input: ReferenceObservationInput): {
    memory: MemoryView
    createdVersion: boolean
  } {
    const parsed = referenceObservationSchema.parse(input)
    const title = this.sanitize(parsed.title)
    const content = normalizeReferenceRule(this.sanitize(parsed.content))
    if (!title || !content) throw new Error("记忆内容脱敏后为空")
    const observationIds = [...new Set(parsed.observationIds)]
    const codeEvidencePaths = [...new Set(parsed.codeEvidencePaths)]
    return this.database.transaction(() => {
      const key = topicKey({ ...parsed, title })
      const now = new Date().toISOString()
      let fact = this.database.readFacts("WHERE topic_key=?", [key])[0]
      if (!fact) {
        fact = { id: randomUUID(), topicKey: key, title, currentVersionId: null, createdAt: now }
        this.database.insertFact(fact)
      }
      const proposedEvidenceEvents = observationIds.map((observationId) => eventFor({
        type: "ai_observation",
        content,
        factId: fact.id,
        sourceRef: observationId,
        scope: parsed.scope,
        region: parsed.region,
        branch: parsed.branch,
        codeRevision: null,
        risk: parsed.risk,
        confidence: parsed.confidence,
        actor: "人工参考学习",
        occurredAt: now,
      }))
      proposedEvidenceEvents.push(...codeEvidencePaths.map((relativePath) => eventFor({
        type: "code",
        content: `当前代码证据：${relativePath}\n${content}`.slice(0, 24_000),
        factId: fact!.id,
        sourceRef: `${parsed.snapshotId}:${relativePath}`.slice(0, 240),
        scope: parsed.scope,
        region: parsed.region,
        branch: parsed.branch,
        codeRevision: parsed.codeRevision,
        risk: parsed.risk,
        confidence: parsed.confidence,
        actor: "当前已发布代码快照",
        occurredAt: now,
      })))
      const evidenceEvents = proposedEvidenceEvents.map((event) => {
        const existing = this.database.prepare(`SELECT id FROM memory_events
          WHERE type=? AND fact_id=? AND source_ref=? AND content=? AND scope=?
            AND region IS ? AND branch IS ? AND risk=? AND code_revision IS ?
          ORDER BY occurred_at,id LIMIT 1`).get(
          event.type,
          event.factId,
          event.sourceRef,
          event.content,
          event.scope,
          event.region,
          event.branch,
          event.risk,
          event.codeRevision,
        ) as { id: string } | undefined
        if (existing) return this.database.readEvents("WHERE id=?", [existing.id])[0]!
        this.database.insertEvent(event)
        return event
      })

      const contentHash = sha256(content)
      const activeAtStart = this.database.readVersions(
        "WHERE fact_id=? AND status='active' ORDER BY version_number DESC LIMIT 1",
        [fact.id],
      )[0]
      const sameRow = this.database.prepare(`SELECT id FROM memory_versions
        WHERE fact_id=? AND content_hash=? ORDER BY version_number DESC LIMIT 1`).get(
        fact.id,
        contentHash,
      ) as { id: string } | undefined
      let createdVersion = false
      let versionId: string
      if (sameRow) {
        const same = this.getMemory(sameRow.id)
        if (memoryRiskRank[parsed.risk] > memoryRiskRank[same.risk]) {
          const versions = this.database.readVersions("WHERE fact_id=? ORDER BY version_number DESC", [fact.id])
          const status: MemoryStatus = parsed.action === "conflict" || same.status === "active" || same.status === "conflict"
            ? "conflict"
            : "candidate"
          this.database.prepare("UPDATE memory_versions SET status='superseded',valid_to=? WHERE id=?").run(now, same.id)
          const escalated: MemoryVersion = {
            id: randomUUID(),
            factId: fact.id,
            version: (versions[0]?.version ?? 0) + 1,
            title,
            content,
            scope: parsed.scope,
            region: parsed.region,
            branch: parsed.branch,
            source: "ai_observation",
            risk: parsed.risk,
            confidence: parsed.confidence,
            status,
            conflictReason: status === "conflict" ? "同一规则出现更高风险或冲突证据，等待人工审核" : null,
            validFrom: now,
            validTo: null,
            createdByEventId: evidenceEvents[0]!.id,
            createdAt: now,
          }
          this.database.insertVersion(escalated, contentHash)
          this.database.prepare(`INSERT OR IGNORE INTO memory_version_evidence(memory_version_id,event_id)
            SELECT ?,event_id FROM memory_version_evidence WHERE memory_version_id=?`).run(escalated.id, same.id)
          evidenceEvents.forEach((event) => this.database.insertVersionEvidence(escalated.id, event.id))
          versionId = escalated.id
          createdVersion = true
          this.database.bumpMemoryGeneration()
        } else if (parsed.action === "conflict" && same.status === "active") {
          const versions = this.database.readVersions("WHERE fact_id=? ORDER BY version_number DESC", [fact.id])
          const conflict: MemoryVersion = {
            id: randomUUID(),
            factId: fact.id,
            version: (versions[0]?.version ?? 0) + 1,
            title,
            content,
            scope: parsed.scope,
            region: parsed.region,
            branch: parsed.branch,
            source: "ai_observation",
            risk: same.risk,
            confidence: parsed.confidence,
            status: "conflict",
            conflictReason: "模型对当前 active 规则明确提出冲突，等待人工审核",
            validFrom: now,
            validTo: null,
            createdByEventId: evidenceEvents[0]!.id,
            createdAt: now,
          }
          this.database.insertVersion(conflict, contentHash)
          evidenceEvents.forEach((event) => this.database.insertVersionEvidence(conflict.id, event.id))
          versionId = conflict.id
          createdVersion = true
          this.database.bumpMemoryGeneration()
        } else {
          versionId = sameRow.id
          evidenceEvents.forEach((event) => this.database.insertVersionEvidence(versionId, event.id))
          if (parsed.action === "conflict" && same.status === "candidate") {
            this.database.prepare(`UPDATE memory_versions SET status='conflict',
              conflict_reason='模型提议存在冲突，等待人工审核' WHERE id=?`).run(versionId)
            this.database.bumpMemoryGeneration()
          }
        }
      } else {
        const versions = this.database.readVersions("WHERE fact_id=? ORDER BY version_number DESC", [fact.id])
        const hasDifferentConclusion = versions.length > 0
        const status: MemoryStatus = parsed.action === "conflict" || hasDifferentConclusion ? "conflict" : "candidate"
        const version: MemoryVersion = {
          id: randomUUID(),
          factId: fact.id,
          version: (versions[0]?.version ?? 0) + 1,
          title,
          content,
          scope: parsed.scope,
          region: parsed.region,
          branch: parsed.branch,
          source: "ai_observation",
          risk: parsed.risk,
          confidence: parsed.confidence,
          status,
          conflictReason: status === "conflict" ? "同一主题存在不同结论或模型明确提议冲突，等待人工审核" : null,
          validFrom: now,
          validTo: null,
          createdByEventId: evidenceEvents[0]!.id,
          createdAt: now,
        }
        this.database.insertVersion(version, contentHash)
        evidenceEvents.forEach((event) => this.database.insertVersionEvidence(version.id, event.id))
        versionId = version.id
        createdVersion = true
        this.database.bumpMemoryGeneration()
      }

      if (activeAtStart && memoryRiskRank[parsed.risk] > memoryRiskRank[activeAtStart.risk]) {
        this.database.prepare("UPDATE memory_versions SET status='superseded',valid_to=? WHERE id=?").run(now, activeAtStart.id)
        this.database.setCurrentVersion(fact.id, null)
        this.database.bumpMemoryGeneration()
      }
      const current = this.getMemory(versionId)
      const hasCurrentCodeEvidence = codeEvidencePaths.length > 0 || Boolean(parsed.snapshotId && this.database.prepare(`SELECT 1
        FROM memory_version_evidence evidence
        JOIN memory_events event ON event.id=evidence.event_id
        WHERE evidence.memory_version_id=? AND event.type='code' AND event.source_ref LIKE ? LIMIT 1`).get(
        versionId,
        `${parsed.snapshotId}:%`,
      ))
      if (current.status === "candidate" && current.risk === "low" && parsed.risk === "low"
        && parsed.action !== "conflict" && hasCurrentCodeEvidence) {
        const trustedThreads = this.database.prepare(`SELECT COUNT(DISTINCT observation.thread_id) AS count
          FROM memory_version_evidence evidence
          JOIN memory_events event ON event.id=evidence.event_id AND event.type='ai_observation'
          JOIN learning_source_observations observation ON observation.id=event.source_ref
          JOIN telegram_roles role ON role.telegram_user_id=observation.source_telegram_user_id
          WHERE evidence.memory_version_id=?
            AND observation.thread_id IS NOT NULL
            AND observation.risk='low'
            AND role.enabled=1
            AND role.learning_source_enabled=1
            AND role.role=observation.source_role`).get(versionId) as { count: number }
        const unresolvedConflict = this.database.prepare(`SELECT 1 FROM memory_versions
          WHERE fact_id=? AND status IN ('active','conflict') AND id<>? LIMIT 1`).get(current.factId, current.id)
        if (Number(trustedThreads.count) >= 2 && !unresolvedConflict) {
          this.database.prepare("UPDATE memory_versions SET status='active',conflict_reason=NULL WHERE id=?").run(versionId)
          this.database.setCurrentVersion(current.factId, versionId)
          this.database.bumpMemoryGeneration()
        }
      }
      return { memory: this.getMemory(versionId), createdVersion }
    })
  }

  async setMemoryStatus(versionId: string, status: MemoryStatus, actor: string): Promise<MemoryView> {
    const memory = this.getMemory(versionId)
    const now = new Date().toISOString()
    return this.database.transaction(() => {
      const event = eventFor({
        type: "human_rule", content: `将记忆“${memory.title}”标记为${status}`, factId: memory.factId,
        scope: memory.scope, region: memory.region, branch: memory.branch, risk: memory.risk,
        confidence: 1, actor: this.sanitize(actor) || "后台管理员", occurredAt: now,
      })
      this.database.insertEvent(event)
      this.database.insertVersionEvidence(memory.id, event.id)
      if (status === "active") {
        this.supersedeActive(memory.factId, now)
        this.database.prepare("UPDATE memory_versions SET status='active',valid_to=NULL,conflict_reason=NULL WHERE id=?").run(versionId)
        this.database.setCurrentVersion(memory.factId, versionId)
      } else {
        this.database.prepare("UPDATE memory_versions SET status=?,valid_to=CASE WHEN ? IN ('disabled','superseded') THEN ? ELSE valid_to END WHERE id=?").run(
          status, status, now, versionId,
        )
        if (memory.currentVersionId === versionId) this.database.setCurrentVersion(memory.factId, null)
      }
      this.database.bumpMemoryGeneration()
      return this.getMemory(versionId)
    })
  }

  listMemories(filters: {
    factId?: string
    status?: MemoryStatus
    scope?: string
    region?: string
    branch?: string
    q?: string
    limit?: number
  } = {}): MemoryView[] {
    const clauses: string[] = []
    const parameters: Array<string | number | null> = []
    if (filters.factId) { clauses.push("v.fact_id=?"); parameters.push(filters.factId) }
    if (filters.status) { clauses.push("v.status=?"); parameters.push(filters.status) }
    if (filters.scope) { clauses.push("v.scope IN (?, 'global')"); parameters.push(filters.scope) }
    if (filters.region) { clauses.push("(v.region=? OR v.region IS NULL)"); parameters.push(filters.region) }
    if (filters.branch) { clauses.push("(v.branch=? OR v.branch IS NULL)"); parameters.push(filters.branch) }
    if (filters.q?.trim()) {
      const query = normalize(filters.q)
      if (query.length >= 3) {
        const match = `"${query.replaceAll('"', '""')}"`
        const rows = this.database.prepare(`SELECT memory_versions.id AS id FROM memory_fts
          JOIN memory_versions ON memory_versions.rowid=memory_fts.rowid
          WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT 200`).all(match) as Array<{ id: string }>
        if (rows.length === 0) return []
        clauses.push(`v.id IN (${rows.map(() => "?").join(",")})`)
        parameters.push(...rows.map((row) => row.id))
      } else {
        clauses.push("(v.title LIKE ? OR v.content LIKE ?)")
        parameters.push(`%${query}%`, `%${query}%`)
      }
    }
    const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500)
    const where = `${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY CASE v.status WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 WHEN 'conflict' THEN 2 WHEN 'superseded' THEN 3 ELSE 4 END,
      v.created_at DESC LIMIT ${limit}`
    return this.database.readMemoryViews(where, parameters)
  }

  listAnswerMemories(filters: {
    scope?: string
    region?: string | null
    branch?: string | null
    q?: string
    limit?: number
  } = {}): MemoryView[] {
    const limit = Math.min(Math.max(filters.limit ?? 24, 1), 24)
    const scopeClauses = ["v.status='active'"]
    const scopeParameters: Array<string | number | null> = []
    if (filters.scope) { scopeClauses.push("v.scope IN (?, 'global')"); scopeParameters.push(filters.scope) }
    if (filters.region) { scopeClauses.push("(v.region=? OR v.region IS NULL)"); scopeParameters.push(filters.region) }
    if (filters.branch) { scopeClauses.push("(v.branch=? OR v.branch IS NULL)"); scopeParameters.push(filters.branch) }

    const recentLimit = Math.min(8, limit)
    const corrections = this.database.readMemoryViews(
      `WHERE ${scopeClauses.join(" AND ")} AND v.source='correction' ORDER BY v.created_at DESC LIMIT ${recentLimit}`,
      scopeParameters,
    )
    const result = [...corrections]
    const seen = new Set(result.map((memory) => memory.id))
    const relevantLimit = Math.min(16, limit)
    const query = filters.q?.trim() ?? ""
    const match = ftsTrigramQuery(query)
    let relevantIds: string[] = []
    if (match) {
      const rows = this.database.prepare(`SELECT v.id AS id FROM memory_fts
        JOIN memory_versions v ON v.rowid=memory_fts.rowid
        WHERE memory_fts MATCH ? AND ${scopeClauses.join(" AND ")}
        ORDER BY CASE WHEN v.source='correction' THEN 0 ELSE 1 END,bm25(memory_fts),v.created_at DESC
        LIMIT 200`).all(match, ...scopeParameters) as Array<{ id: string }>
      relevantIds = rows.map((row) => row.id)
    } else if (query) {
      const rows = this.database.prepare(`SELECT v.id AS id FROM memory_versions v
        WHERE ${scopeClauses.join(" AND ")} AND (v.title LIKE ? OR v.content LIKE ?)
        ORDER BY CASE WHEN v.source='correction' THEN 0 ELSE 1 END,v.created_at DESC LIMIT 200`).all(
        ...scopeParameters,
        `%${normalize(query)}%`,
        `%${normalize(query)}%`,
      ) as Array<{ id: string }>
      relevantIds = rows.map((row) => row.id)
    } else {
      relevantIds = this.database.readMemoryViews(
        `WHERE ${scopeClauses.join(" AND ")} ORDER BY CASE WHEN v.source='correction' THEN 0 ELSE 1 END,v.created_at DESC LIMIT ${relevantLimit}`,
        scopeParameters,
      ).map((memory) => memory.id)
    }
    for (const id of relevantIds) {
      if (seen.has(id)) continue
      result.push(this.getMemory(id))
      seen.add(id)
      if (result.length >= limit || result.length >= recentLimit + relevantLimit) break
    }
    return result.slice(0, limit)
  }

  getMemory(versionId: string): MemoryView {
    const memory = this.database.readMemoryViews("WHERE v.id=?", [versionId])[0]
    if (!memory) throw new Error("AI 记忆不存在")
    return memory
  }

  getMemoryEvidence(versionId: string): MemoryEvidenceSummary {
    this.getMemory(versionId)
    const rows = this.database.prepare(`SELECT event.type,event.source_ref,event.code_revision,
      observation.id AS observation_id,observation.thread_id
      FROM memory_version_evidence evidence
      JOIN memory_events event ON event.id=evidence.event_id
      LEFT JOIN learning_source_observations observation
        ON event.type='ai_observation' AND observation.id=event.source_ref
      WHERE evidence.memory_version_id=? ORDER BY event.occurred_at,event.id`).all(versionId) as Array<{
      type: MemoryEventType
      source_ref: string | null
      code_revision: string | null
      observation_id: string | null
      thread_id: string | null
    }>
    const codeEvidence = new Map<string, MemoryEvidenceSummary["codeEvidence"][number]>()
    const sourceThreads = new Map<string, MemoryEvidenceSummary["sourceThreads"][number]>()
    rows.forEach((row) => {
      if (row.type === "code" && row.source_ref) {
        const separator = row.source_ref.indexOf(":")
        if (separator > 0 && separator < row.source_ref.length - 1) {
          const evidence = {
            snapshotId: row.source_ref.slice(0, separator),
            path: row.source_ref.slice(separator + 1),
            codeRevision: row.code_revision,
          }
          codeEvidence.set(`${evidence.snapshotId}:${evidence.path}:${evidence.codeRevision ?? ""}`, evidence)
        }
      }
      if (row.observation_id && row.thread_id) {
        sourceThreads.set(`${row.observation_id}:${row.thread_id}`, {
          observationId: row.observation_id,
          threadId: row.thread_id,
        })
      }
    })
    return { codeEvidence: [...codeEvidence.values()], sourceThreads: [...sourceThreads.values()] }
  }

  listEvents(filters: { type?: MemoryEventType; factId?: string; limit?: number } = {}): MemoryEvent[] {
    const clauses: string[] = []
    const parameters: Array<string | number> = []
    if (filters.type) { clauses.push("type=?"); parameters.push(filters.type) }
    if (filters.factId) { clauses.push("fact_id=?"); parameters.push(filters.factId) }
    const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500)
    return this.database.readEvents(`${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY occurred_at DESC LIMIT ${limit}`, parameters)
  }

  listReplyRecords(filters: { status?: ReplyRecord["status"]; groupId?: string; q?: string } = {}): ReplyRecord[] {
    const clauses: string[] = []
    const parameters: string[] = []
    if (filters.status) { clauses.push("status=?"); parameters.push(filters.status) }
    if (filters.groupId) { clauses.push("group_id=?"); parameters.push(filters.groupId) }
    if (filters.q?.trim()) {
      clauses.push("(question LIKE ? OR answer LIKE ? OR service LIKE ?)")
      parameters.push(...Array(3).fill(`%${filters.q.trim()}%`))
    }
    return this.database.readReplies(`${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC`, parameters)
  }

  getReply(id: string): ReplyRecord {
    const reply = this.database.readReplies("WHERE id=?", [id])[0]
    if (!reply) throw new Error("回复记录不存在")
    return reply
  }

  async recordReply(input: ReplyInput): Promise<ReplyRecord> {
    const parsed = replyInputSchema.parse(input)
    const now = new Date().toISOString()
    const question = this.sanitize(parsed.question)
    const answer = this.sanitize(parsed.answer)
    const quote = parsed.quote ? this.sanitize(parsed.quote) : null
    if (!question) throw new Error("问题内容脱敏后为空")
    const status: ReplyRecord["status"] = parsed.decision === "ignore" ? "ignored" : parsed.decision === "escalate" ? "escalated" : "replied"
    const record: ReplyRecord = {
      ...parsed, question, answer, quote, id: randomUUID(), threadId: null, inputRevision: null,
      status, createdAt: now, updatedAt: now,
      generationStartedAt: null, heartbeatAt: null, durationMs: null, errorCode: null, correctedAt: null,
      codeSnapshotId: null, codeSyncBatchId: null,
      operatorDeliveryStatus: null,
      senderUserId: null, senderUsername: null, senderDisplayName: null, senderRole: null,
      serviceSource: null, decisionReason: null, decisionConfidence: null,
    }
    return this.database.transaction(() => {
      this.database.insertReply(record)
      this.database.insertEvent(eventFor({
        type: "question", content: question, factId: null, replyRecordId: record.id, sourceRef: parsed.telegramMessageId,
        scope: parsed.service || "global", region: null, branch: null, codeRevision: parsed.codeRevision,
        risk: "low", confidence: 1, actor: "telegram", occurredAt: now,
      }))
      if (answer) this.database.insertEvent(eventFor({
        type: "reply", content: answer, factId: null, replyRecordId: record.id, sourceRef: parsed.telegramReplyMessageId,
        scope: parsed.service || "global", region: null, branch: null, codeRevision: parsed.codeRevision,
        risk: "low", confidence: 1, actor: "codex", occurredAt: now,
      }))
      return record
    })
  }

  async correctReply(replyRecordId: string, input: CorrectionInput): Promise<{ event: MemoryEvent; memory: MemoryView; reply: ReplyRecord }> {
    const parsed = correctionInputSchema.parse(input)
    const correctedAnswer = this.sanitize(parsed.correctedAnswer)
    const reason = this.sanitize(parsed.reason)
    if (!correctedAnswer || !reason) throw new Error("纠正内容脱敏后为空")
    return this.database.transaction(() => {
      const reply = this.getReply(replyRecordId)
      const authoredTitle = parsed.title ? this.sanitize(parsed.title) : ""
      const title = authoredTitle || `纠正：${reply.question.slice(0, 120)}`
      const defaultApplicability = `当出现与“${reply.question.slice(0, 240)}”同类或近义的场景时，优先采用这条人工纠正；除非人工明确限定，否则规则跨项目、服务、通道、订单和错误码通用。`
      const defaultMemoryContent = [
        `适用条件：${defaultApplicability}`,
        `回答原则：${reason}`,
        "生成要求：人工正确回答只保存在原始证据中 当前记忆只约束处理意图 回答模型必须结合最新消息重新组织文案",
      ].join("\n")
      const memoryContent = (parsed.memoryContent ? this.sanitize(parsed.memoryContent) : defaultMemoryContent).slice(0, 12000)
      const referencedMemories = reply.memoryVersionRefs.map((versionId) => this.getMemory(versionId))
      const latestCorrection = referencedMemories
        .filter((memory) => memory.source === "correction")
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      const referencedFacts = new Set(referencedMemories.map((memory) => memory.factId))
      const referenced = latestCorrection ?? (referencedFacts.size === 1 ? referencedMemories[0] : undefined)
      const now = new Date().toISOString()
      let fact = referenced ? this.database.readFacts("WHERE id=?", [referenced.factId])[0] : undefined
      if (!fact) {
        fact = { id: randomUUID(), topicKey: topicKey({ title, scope: parsed.scope, region: parsed.region, branch: parsed.branch }), title, currentVersionId: null, createdAt: now }
        this.database.insertFact(fact)
      }
      const event = eventFor({
        type: "correction", content: [
          `原问题：${reply.question}`,
          `人工正确回答：${correctedAnswer}`,
          `纠正原因：${reason}`,
        ].join("\n").slice(0, 24000), factId: fact.id,
        replyRecordId, scope: parsed.scope, region: parsed.region, branch: parsed.branch,
        codeRevision: reply.codeRevision, risk: referenced?.risk ?? "low", confidence: 1,
        actor: parsed.correctedBy, occurredAt: now,
      })
      this.database.insertEvent(event)
      const versions = this.database.readVersions("WHERE fact_id=? ORDER BY version_number DESC", [fact.id])
      this.supersedeActive(fact.id, now)
      const version: MemoryVersion = {
        id: randomUUID(), factId: fact.id, version: (versions[0]?.version ?? 0) + 1, title: fact.title,
        content: memoryContent, scope: parsed.scope, region: parsed.region, branch: parsed.branch,
        source: "correction", risk: referenced?.risk ?? "low", confidence: 1, status: "active",
        conflictReason: null, validFrom: now, validTo: null, createdByEventId: event.id, createdAt: now,
      }
      this.database.insertVersion(version, sha256(memoryContent))
      this.database.insertVersionEvidence(version.id, event.id)
      this.database.setCurrentVersion(fact.id, version.id)
      this.database.prepare("INSERT OR IGNORE INTO reply_memory_refs(reply_id,memory_version_id) VALUES (?,?)").run(replyRecordId, version.id)
      this.database.prepare("UPDATE support_replies SET status='corrected',updated_at=?,corrected_at=? WHERE id=?").run(now, now, replyRecordId)
      this.database.bumpMemoryGeneration()
      return { event, memory: this.getMemory(version.id), reply: this.getReply(replyRecordId) }
    })
  }

  async createStandaloneCorrection(input: StandaloneCorrectionInput): Promise<{ event: MemoryEvent; memory: MemoryView }> {
    const parsed = standaloneCorrectionInputSchema.parse(input)
    const originalQuestion = this.sanitize(parsed.originalQuestion)
    const previousAnswer = this.sanitize(parsed.previousAnswer)
    const correctedAnswer = this.sanitize(parsed.correctedAnswer)
    const reason = this.sanitize(parsed.reason)
    if (!originalQuestion || !correctedAnswer || !reason) throw new Error("纠正内容脱敏后为空")
    return this.database.transaction(() => {
      const authoredTitle = parsed.title ? this.sanitize(parsed.title) : ""
      const title = authoredTitle || `纠正：${originalQuestion.slice(0, 120)}`
      const defaultApplicability = `当出现与“${originalQuestion.slice(0, 240)}”同类或近义的场景时，优先采用这条人工纠正；除非人工明确限定，否则规则跨项目、服务、通道、订单和错误码通用。`
      const defaultMemoryContent = [
        `适用条件：${defaultApplicability}`,
        `回答原则：${reason}`,
        "生成要求：人工正确回答只保存在原始证据中 当前记忆只约束处理意图 回答模型必须结合最新消息重新组织文案",
      ].join("\n")
      const memoryContent = (parsed.memoryContent ? this.sanitize(parsed.memoryContent) : defaultMemoryContent).slice(0, 12000)
      const referencedMemories = parsed.referencedMemoryIds.flatMap((versionId) => {
        try { return [this.getMemory(versionId)] } catch { return [] }
      })
      const latestCorrection = referencedMemories
        .filter((memory) => memory.source === "correction")
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      const referencedFacts = new Set(referencedMemories.map((memory) => memory.factId))
      const referenced = latestCorrection ?? (referencedFacts.size === 1 ? referencedMemories[0] : undefined)
      const now = new Date().toISOString()
      let fact = referenced ? this.database.readFacts("WHERE id=?", [referenced.factId])[0] : undefined
      if (!fact) {
        fact = {
          id: randomUUID(),
          topicKey: topicKey({ title, scope: parsed.scope, region: parsed.region, branch: parsed.branch }),
          title,
          currentVersionId: null,
          createdAt: now,
        }
        this.database.insertFact(fact)
      }
      const event = eventFor({
        type: "correction",
        sourceRef: parsed.sourceRef,
        content: [
          `原问题：${originalQuestion}`,
          `原回答：${previousAnswer || "无"}`,
          `人工正确回答：${correctedAnswer}`,
          `纠正原因：${reason}`,
        ].join("\n").slice(0, 24000),
        factId: fact.id,
        scope: parsed.scope,
        region: parsed.region,
        branch: parsed.branch,
        codeRevision: parsed.codeRevision,
        risk: referenced?.risk ?? "low",
        confidence: 1,
        actor: parsed.correctedBy,
        occurredAt: now,
      })
      this.database.insertEvent(event)
      const versions = this.database.readVersions("WHERE fact_id=? ORDER BY version_number DESC", [fact.id])
      this.supersedeActive(fact.id, now)
      const version: MemoryVersion = {
        id: randomUUID(), factId: fact.id, version: (versions[0]?.version ?? 0) + 1, title: fact.title,
        content: memoryContent, scope: parsed.scope, region: parsed.region, branch: parsed.branch,
        source: "correction", risk: referenced?.risk ?? "low", confidence: 1, status: "active",
        conflictReason: null, validFrom: now, validTo: null, createdByEventId: event.id, createdAt: now,
      }
      this.database.insertVersion(version, sha256(memoryContent))
      this.database.insertVersionEvidence(version.id, event.id)
      this.database.setCurrentVersion(fact.id, version.id)
      this.database.bumpMemoryGeneration()
      return { event, memory: this.getMemory(version.id) }
    })
  }

  private supersedeActive(factId: string, at: string): void {
    this.database.prepare("UPDATE memory_versions SET status='superseded',valid_to=? WHERE fact_id=? AND status='active'").run(at, factId)
  }

  private evidenceTypes(versionId: string): MemoryEventType[] {
    const rows = this.database.prepare(`SELECT e.type AS type FROM memory_version_evidence ve
      JOIN memory_events e ON e.id=ve.event_id WHERE ve.memory_version_id=? ORDER BY e.occurred_at`).all(versionId) as Array<{ type: MemoryEventType }>
    return rows.map((row) => row.type)
  }

  private independentEvidenceCount(versionId: string): number {
    const row = this.database.prepare(`SELECT COUNT(DISTINCT
      CASE WHEN e.source_ref IS NOT NULL AND e.source_ref != '' THEN e.type || ':' || e.source_ref
      WHEN e.code_revision IS NOT NULL AND e.code_revision != '' THEN e.type || ':' || e.code_revision
      ELSE e.type || ':' || e.actor END) AS total
      FROM memory_version_evidence ve JOIN memory_events e ON e.id=ve.event_id
      WHERE ve.memory_version_id=?`).get(versionId) as { total: number }
    return Number(row.total)
  }
}

export function isMemoryStatus(value: string | undefined): value is MemoryStatus {
  return value !== undefined && memoryStatusSchema.safeParse(value).success
}
