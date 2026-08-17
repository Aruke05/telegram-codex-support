import type { ProjectCodeSnapshot } from "../git-sync/project-service.js"
import type { ModelConfigService } from "../runtime/model-config-service.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { RuntimeKnowledgeService } from "../runtime/knowledge-service.js"
import type { MemoryLearningAgentPort } from "./agent.js"

type CodeSyncPort = {
  readCurrentSnapshot(serviceId: string): ProjectCodeSnapshot
}

/**
 * 旧的机器人问答自学习 worker 已退役。
 *
 * 构造参数暂时保留，避免运行装配和第三方调用在迁移期间失效；worker 只负责安全排空历史队列，
 * 不再读取回复正文、代码快照或调用模型。人工 correction 继续走 RuntimeKnowledgeService 的确定性入口。
 */
export class MemoryLearningWorker {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly config: ModelConfigService,
    _knowledge: RuntimeKnowledgeService,
    _agent: MemoryLearningAgentPort,
    _codeSync: CodeSyncPort,
  ) {}

  enqueue(_replyId: string): void {
    // replied / ignored / escalated 等机器人结果不再成为学习来源。
  }

  recoverInterrupted(now = new Date()): number {
    const stale = new Date(now.getTime() - 10 * 60 * 1000).toISOString()
    const timestamp = now.toISOString()
    const result = this.database.prepare(`UPDATE memory_learning_queue SET status='pending',locked_at=NULL,
      next_attempt_at=?,updated_at=? WHERE status='running' AND locked_at<?`).run(timestamp, timestamp, stale)
    return Number(result.changes)
  }

  async runOnce(now = new Date()): Promise<{ processed: number; createdVersions: number; conflicts: number }> {
    const timestamp = now.toISOString()
    const processed = this.database.transaction(() => {
      this.recoverInterrupted(now)
      const rows = this.database.prepare(`SELECT reply_id FROM memory_learning_queue
        WHERE status IN ('pending','failed') ORDER BY created_at,reply_id LIMIT ?`).all(
        this.config.getSettings().learningBatchSize,
      ) as Array<{ reply_id: string }>
      if (rows.length === 0) return 0
      const ids = rows.map((row) => row.reply_id)
      const placeholders = ids.map(() => "?").join(",")
      this.database.prepare(`UPDATE memory_learning_queue SET status='completed',locked_at=NULL,
        last_error='legacy_learning_retired',updated_at=? WHERE reply_id IN (${placeholders})`).run(timestamp, ...ids)
      return ids.length
    })
    return { processed, createdVersions: 0, conflicts: 0 }
  }
}
