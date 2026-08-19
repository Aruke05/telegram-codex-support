import { randomUUID } from "node:crypto"

import type { RuntimeDatabase } from "../runtime/database.js"

export type ShadowDecision = "reply" | "ignore" | "escalate"

export type CompletedShadowAnswer = {
  replyId: string
  threadId: string
  inputRevision: number
  decision: ShadowDecision
  answer: string
  quote: string | null
  reason: string
  confidence: number
  codeRevision: string | null
  memoryVersionRefs: string[]
  simulatedAction: string
  outputRedacted: boolean
}

export class ShadowLearningStore {
  constructor(private readonly database: RuntimeDatabase) {}

  complete(input: CompletedShadowAnswer): void {
    const now = new Date().toISOString()
    this.database.prepare(`INSERT OR IGNORE INTO shadow_answer_results(
      id,reply_id,thread_id,input_revision,outcome_status,decision,answer,quote_text,reason,confidence,
      code_revision,memory_version_refs_json,simulated_action,output_redacted,error_code,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), input.replyId, input.threadId, input.inputRevision, "completed", input.decision,
      input.answer, input.quote, input.reason, input.confidence, input.codeRevision,
      JSON.stringify(input.memoryVersionRefs), input.simulatedAction, input.outputRedacted ? 1 : 0,
      null, now, now,
    )
    this.database.prepare(`UPDATE shadow_human_answer_links SET shadow_result_id=(
        SELECT id FROM shadow_answer_results result
        WHERE result.thread_id=shadow_human_answer_links.thread_id
          AND result.input_revision=shadow_human_answer_links.input_revision
      ) WHERE thread_id=? AND input_revision=? AND shadow_result_id IS NULL`)
      .run(input.threadId, input.inputRevision)
  }

  fail(input: {
    replyId: string
    threadId: string
    inputRevision: number
    errorCode: string
    reason: string
    codeRevision?: string | null
  }): void {
    const now = new Date().toISOString()
    this.database.prepare(`INSERT OR IGNORE INTO shadow_answer_results(
      id,reply_id,thread_id,input_revision,outcome_status,decision,answer,quote_text,reason,confidence,
      code_revision,memory_version_refs_json,simulated_action,output_redacted,error_code,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), input.replyId, input.threadId, input.inputRevision, "failed", null,
      "", null, input.reason, null, input.codeRevision ?? null, "[]", "none", 0,
      input.errorCode, now, now,
    )
  }

  linkHumanAnswer(input: {
    observationId: string
    humanMessageEventId: string
    primaryThreadId: string
  }): string[] {
    return this.database.transaction(() => {
    const parent = this.database.prepare(`SELECT target_thread_id FROM support_thread_links
      WHERE source_thread_id=? AND relation='split_from' ORDER BY created_at,target_thread_id LIMIT 1`)
      .get(input.primaryThreadId) as { target_thread_id?: string } | undefined
    const rootThreadId = parent?.target_thread_id ?? input.primaryThreadId
    const related = this.database.prepare(`SELECT source_thread_id FROM support_thread_links
      WHERE target_thread_id=? AND relation='split_from' ORDER BY created_at,source_thread_id`)
      .all(rootThreadId) as Array<{ source_thread_id: string }>
    const threadIds = [...new Set([rootThreadId, ...related.map((row) => row.source_thread_id)])]
    const now = new Date().toISOString()
    const insert = this.database.prepare(`INSERT OR IGNORE INTO shadow_human_answer_links(
      id,observation_id,human_message_event_id,thread_id,input_revision,shadow_result_id,
      match_reason,match_confidence,created_at
    ) SELECT ?,?,?,?,?,result.id,?,?,? FROM support_threads thread
      LEFT JOIN shadow_answer_results result
        ON result.thread_id=thread.id AND result.input_revision=thread.revision
      WHERE thread.id=? AND thread.answer_operation_mode='learning'`)
    for (const threadId of threadIds) {
      const thread = this.database.prepare("SELECT revision FROM support_threads WHERE id=?")
        .get(threadId) as { revision?: number } | undefined
      if (!thread?.revision) continue
      insert.run(
        randomUUID(), input.observationId, input.humanMessageEventId, threadId, thread.revision,
        threadId === input.primaryThreadId ? "direct" : "split_family",
        threadId === input.primaryThreadId ? 1 : 0.6,
        now,
        threadId,
      )
    }
    return threadIds
    })
  }
}
