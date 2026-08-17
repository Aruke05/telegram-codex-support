import { z } from "zod"

import type { CodexExecutor } from "../codex/executor.js"
import {
  referenceProposalResultJsonSchema,
  referenceProposalResultSchema,
  type ReferenceProposalResult,
} from "../codex/schemas.js"
import type { ProjectCodeSnapshot } from "../git-sync/project-service.js"
import type { MemoryView } from "../runtime/types.js"

const safeThreadMessageSchema = z.object({
  role: z.enum(["question", "reference", "context"]),
  safeText: z.string().trim().min(1).max(4000),
}).strict()

export const safeReferenceThreadContextSchema = z.object({
  observationId: z.string().uuid(),
  threadId: z.string().uuid(),
  messages: z.array(safeThreadMessageSchema).min(1).max(24),
}).strict().superRefine((value, context) => {
  const referenceCount = value.messages.filter((message) => message.role === "reference").length
  if (referenceCount !== 1) {
    context.addIssue({ code: "custom", path: ["messages"], message: "thread context 必须且只能包含一个 reference" })
  }
  const total = value.messages.reduce((sum, message) => sum + message.safeText.length, 0)
  if (total > 24_000) {
    context.addIssue({ code: "custom", path: ["messages"], message: "安全线程上下文总长度超限" })
  }
})

export type SafeReferenceThreadContext = z.infer<typeof safeReferenceThreadContextSchema>

export const referenceLearningTargetSchema = z.object({
  scope: z.string().trim().min(1).max(120),
  region: z.string().trim().min(1).max(120).nullable(),
  branch: z.string().trim().min(1).max(120),
}).strict()

export type ReferenceLearningTarget = z.infer<typeof referenceLearningTargetSchema>

export type ReferenceAgentInput = {
  target: ReferenceLearningTarget
  threadContexts: SafeReferenceThreadContext[]
  activeMemories: MemoryView[]
  codeSnapshot: ProjectCodeSnapshot
}

export type ReferenceAgentPort = {
  classify(input: ReferenceAgentInput): Promise<ReferenceProposalResult>
}

export const REFERENCE_LEARNING_BATCH_LIMIT = 30
export const REFERENCE_LEARNING_AGGREGATE_CHAR_BUDGET = 60_000
export const REFERENCE_REDACTED_MARKER = "◼"
export const REFERENCE_TRANSIENT_URL_MARKER = "◈"
const REFERENCE_LITERAL_REDACTED_MARKER = "〔原文脱敏标记〕"
const REFERENCE_LITERAL_TRANSIENT_URL_MARKER = "〔原文临时URL标记〕"
const REFERENCE_LITERAL_REDACTED_SYMBOL = "〔原文黑方块符号〕"
const REFERENCE_LITERAL_TRANSIENT_URL_SYMBOL = "〔原文菱形符号〕"

export function escapeReferenceLearningMarkerLiterals(value: string): string {
  return value
    .replace(/\[已脱敏\]\[临时URL\]/gu, REFERENCE_LITERAL_TRANSIENT_URL_MARKER)
    .replace(/\[已脱敏\]/gu, REFERENCE_LITERAL_REDACTED_MARKER)
    .replaceAll(REFERENCE_REDACTED_MARKER, REFERENCE_LITERAL_REDACTED_SYMBOL)
    .replaceAll(REFERENCE_TRANSIENT_URL_MARKER, REFERENCE_LITERAL_TRANSIENT_URL_SYMBOL)
}

export function normalizeReferenceLearningText(value: string): string {
  return value
    .replace(/\[已脱敏\]\[临时URL\]/gu, REFERENCE_TRANSIENT_URL_MARKER)
    .replace(/\[已脱敏\]/gu, REFERENCE_REDACTED_MARKER)
}

type CharacterRequest = {
  desired: number
  minimum: number
}

function fairCharacterAllocations(requests: CharacterRequest[], budget: number): number[] {
  if (requests.length === 0) return []
  const minimumTotal = requests.reduce((sum, request) => sum + request.minimum, 0)
  if (minimumTotal > budget) throw new Error("参考学习总字符预算不足以保留必要输入")
  let lower = 0
  let upper = Math.max(...requests.map((request) => request.desired))
  let fairCap = 0
  while (lower <= upper) {
    const candidate = Math.floor((lower + upper) / 2)
    const total = requests.reduce((sum, request) => (
      sum + Math.min(request.desired, Math.max(request.minimum, candidate))
    ), 0)
    if (total <= budget) {
      fairCap = candidate
      lower = candidate + 1
    } else {
      upper = candidate - 1
    }
  }
  const allocations = requests.map((request) => Math.min(request.desired, Math.max(request.minimum, fairCap)))
  let remaining = budget - allocations.reduce((sum, allocation) => sum + allocation, 0)
  while (remaining > 0) {
    let changed = false
    for (let index = 0; index < requests.length && remaining > 0; index += 1) {
      if (allocations[index]! >= requests[index]!.desired) continue
      allocations[index]! += 1
      remaining -= 1
      changed = true
    }
    if (!changed) break
  }
  return allocations
}

function boundThreadContext(context: SafeReferenceThreadContext, budget: number): SafeReferenceThreadContext {
  const allocations = fairCharacterAllocations(context.messages.map((message) => ({
    desired: message.safeText.length,
    minimum: message.role === "reference" ? 1 : 0,
  })), budget)
  return safeReferenceThreadContextSchema.parse({
    ...context,
    messages: context.messages.flatMap((message, index) => {
      const safeText = message.safeText.slice(0, allocations[index])
      return safeText ? [{ ...message, safeText }] : []
    }),
  })
}

function boundActiveMemory(memory: MemoryView, budget: number): MemoryView {
  const title = memory.title
  const content = memory.content.slice(0, 2000)
  const [titleBudget = 0, contentBudget = 0] = fairCharacterAllocations([
    { desired: title.length, minimum: title.length > 0 ? 1 : 0 },
    { desired: content.length, minimum: 0 },
  ], budget)
  return {
    ...memory,
    title: title.slice(0, titleBudget),
    content: content.slice(0, contentBudget),
  }
}

export function boundReferenceLearningMaterial(
  threadContexts: SafeReferenceThreadContext[],
  activeMemories: MemoryView[],
): { threadContexts: SafeReferenceThreadContext[]; activeMemories: MemoryView[] } {
  const normalizedThreadContexts = threadContexts.map((context) => ({
    ...context,
    messages: context.messages.map((message) => ({
      ...message,
      safeText: normalizeReferenceLearningText(message.safeText),
    })),
  }))
  const compactMemories = activeMemories.map((memory) => ({
    ...memory,
    title: escapeReferenceLearningMarkerLiterals(memory.title),
    content: escapeReferenceLearningMarkerLiterals(memory.content).slice(0, 2000),
  }))
  const requests = [
    ...normalizedThreadContexts.map((context) => ({
      desired: context.messages.reduce((sum, message) => sum + message.safeText.length, 0),
      minimum: 1,
    })),
    ...compactMemories.map((memory) => ({
      desired: memory.title.length + memory.content.length,
      minimum: memory.title.length > 0 ? 1 : 0,
    })),
  ]
  const minimumTextBudget = requests.reduce((sum, request) => sum + request.minimum, 0)
  const structuralCharacters = JSON.stringify(normalizedThreadContexts.map((context) => ({
    ...context,
    messages: context.messages.map((message) => ({ ...message, safeText: "" })),
  }))).length + JSON.stringify(compactMemories.map((memory) => ({
    ...compactMemory(memory),
    title: "",
    content: "",
  }))).length
  let textBudget = Math.max(minimumTextBudget, REFERENCE_LEARNING_AGGREGATE_CHAR_BUDGET - structuralCharacters)
  while (true) {
    const allocations = fairCharacterAllocations(requests, textBudget)
    const bounded = {
      threadContexts: normalizedThreadContexts.map((context, index) => boundThreadContext(context, allocations[index]!)),
      activeMemories: compactMemories.map((memory, index) => (
        boundActiveMemory(memory, allocations[normalizedThreadContexts.length + index]!)
      )),
    }
    const serializedCharacters = JSON.stringify(bounded.threadContexts).length
      + JSON.stringify(bounded.activeMemories.map(compactMemory)).length
    if (serializedCharacters <= REFERENCE_LEARNING_AGGREGATE_CHAR_BUDGET) return bounded
    const nextBudget = Math.max(
      minimumTextBudget,
      textBudget - (serializedCharacters - REFERENCE_LEARNING_AGGREGATE_CHAR_BUDGET),
    )
    if (nextBudget === textBudget) throw new Error("参考学习结构化输入超过总字符预算")
    textBudget = nextBudget
  }
}

function compactMemory(memory: MemoryView): Record<string, unknown> {
  return {
    id: memory.versionId,
    title: memory.title,
    content: escapeReferenceLearningMarkerLiterals(memory.content).slice(0, 2000),
    scope: memory.scope,
    region: memory.region,
    branch: memory.branch,
    risk: memory.risk,
  }
}

function snapshotDescription(snapshot: ProjectCodeSnapshot): Record<string, unknown> {
  return {
    service: snapshot.service,
    branch: snapshot.branch,
    commit: snapshot.commit,
    publishedAt: snapshot.publishedAt,
    repositories: snapshot.repositories.map((repository) => ({
      role: repository.role,
      name: repository.name,
      branch: repository.branch,
      commit: repository.commit,
    })),
  }
}

export class CodexReferenceAgent implements ReferenceAgentPort {
  constructor(private readonly codex: CodexExecutor) {}

  async classify(input: ReferenceAgentInput): Promise<ReferenceProposalResult> {
    const target = referenceLearningTargetSchema.parse(input.target)
    const parsedThreadContexts = z.array(safeReferenceThreadContextSchema)
      .min(1)
      .max(REFERENCE_LEARNING_BATCH_LIMIT)
      .parse(input.threadContexts)
    const parsedActiveMemories = input.activeMemories.filter((memory) => memory.status === "active").slice(0, 30)
    const { threadContexts, activeMemories } = boundReferenceLearningMaterial(parsedThreadContexts, parsedActiveMemories)
    const snapshot = input.codeSnapshot
    const prompt = [
      "你是参考回复分类器 只提议不写入数据 只输出结构化 JSON",
      "classification 只能是 style correction business_rule ephemeral action_result general",
      "action 只能是 add reinforce conflict noop 不得执行任何修改 操作或外部请求",
      "只使用下面选定的安全线程上下文 最多 30 条 active memory 和当前已发布代码快照",
      `${REFERENCE_REDACTED_MARKER} 表示已脱敏敏感片段 ${REFERENCE_TRANSIENT_URL_MARKER} 表示已脱敏临时 URL 不得还原或猜测`,
      "不得查服务器 数据库 Redis 网络主机 配置凭据或安全线程上下文以外的聊天记录",
      "evidenceObservationIds 只能引用本批次 observationId codeEvidencePaths 只能填写当前快照仓库内的相对路径",
      "每条提议的 scope region branch 必须逐字复制目标知识维度 不得从聊天内容猜测或改写",
      `目标知识维度 ${JSON.stringify(target)}`,
      `安全线程上下文 ${JSON.stringify(threadContexts)}`,
      `active memories ${JSON.stringify(activeMemories.map(compactMemory))}`,
      `当前代码快照 ${JSON.stringify(snapshotDescription(snapshot))}`,
    ].join("\n\n")
    const result = await this.codex.execute("memory", {
      cwd: snapshot.workspacePath,
      prompt,
      outputSchema: referenceProposalResultJsonSchema as unknown as Record<string, unknown>,
      validator: referenceProposalResultSchema,
      accessMode: "reference-classifier",
      readableRoots: snapshot.repositories.map((repository) => repository.snapshotPath),
    })

    const observationIds = new Set(threadContexts.map((context) => context.observationId))
    const repositoryNames = snapshot.repositories.map((repository) => repository.name)
    for (const proposal of result.proposals) {
      if (proposal.evidenceObservationIds.some((id) => !observationIds.has(id))) {
        throw new Error("分类结果引用了本批次以外的 observation 证据")
      }
      if (proposal.codeEvidencePaths.some((relativePath) => !repositoryNames.some((name) => (
        relativePath === name || relativePath.startsWith(`${name}/`)
      )))) {
        throw new Error("分类结果引用了当前代码快照以外的相对路径")
      }
    }
    return result
  }
}
