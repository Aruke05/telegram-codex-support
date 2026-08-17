import type { CodexExecutor } from "../codex/executor.js"
import { learningResultJsonSchema, learningResultSchema, type LearningResult } from "../codex/schemas.js"
import type { ProjectCodeSnapshot } from "../git-sync/project-service.js"
import type { MemoryView, ReplyRecord } from "../runtime/types.js"

export type LearningBatch = {
  replies: ReplyRecord[]
  memories: MemoryView[]
  codeSnapshot: ProjectCodeSnapshot | null
}

export type MemoryLearningAgentPort = {
  learn(input: LearningBatch): Promise<LearningResult>
}

function compactReply(reply: ReplyRecord): Record<string, unknown> {
  return {
    id: reply.id,
    service: reply.service,
    question: reply.question.slice(0, 3000),
    answer: reply.answer.slice(0, 3000),
    decision: reply.decision,
    correctedAt: reply.correctedAt,
    codeRevision: reply.codeRevision,
  }
}

export class CodexMemoryLearningAgent implements MemoryLearningAgentPort {
  constructor(private readonly codex: CodexExecutor) {}

  learn(input: LearningBatch): Promise<LearningResult> {
    const snapshot = input.codeSnapshot
    const prompt = [
      "你是 AI 客服记忆整理器。只输出结构化 JSON，不回复用户。",
      "目标：从重复问答和人工纠正中提取可复用事实。不要复述临时订单、个人信息或一次性故障。",
      "记忆分层：固定规则由人工维护；本次只整理语义事实。原始问答是情景证据，不能直接覆盖现有事实。",
      "动作：add=新事实，reinforce=支持同结论，conflict=与现有结论冲突，noop=不应记忆。",
      "高风险内容（密钥、签名、权限、安全、生产写操作、资金操作）必须标 high，绝不能建议自动生效。",
      "只有你确实从当前代码快照读到依据时才填写 codeEvidencePaths；路径必须是工作区内相对路径。",
      `代码快照：${snapshot ? JSON.stringify({ branch: snapshot.branch, commit: snapshot.commit, repositories: snapshot.repositories.map((item) => item.name) }) : "无"}`,
      `现有记忆：${JSON.stringify(input.memories.slice(0, 30).map((item) => ({ id: item.id, title: item.title, content: item.content.slice(0, 2000), status: item.status, risk: item.risk, scope: item.scope, branch: item.branch })))}`,
      `待整理问答：${JSON.stringify(input.replies.map(compactReply))}`,
    ].join("\n\n")
    return this.codex.execute("memory", {
      cwd: snapshot?.workspacePath ?? process.cwd(),
      prompt,
      outputSchema: learningResultJsonSchema as unknown as Record<string, unknown>,
      validator: learningResultSchema,
    })
  }
}
