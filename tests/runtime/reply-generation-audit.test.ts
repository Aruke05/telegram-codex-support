import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { BackupService } from "../../src/runtime/backup-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function seededAdminTurn(): Promise<{ database: RuntimeDatabase; sessionId: string; turnId: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "reply-generation-audit-"))
  temporaryDirectories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
  const now = "2026-08-22T00:00:00.000Z"
  const projectId = "00000000-0000-4000-8000-000000000801"
  const serviceId = "00000000-0000-4000-8000-000000000802"
  const userId = "00000000-0000-4000-8000-000000000803"
  const sessionId = "00000000-0000-4000-8000-000000000804"
  const turnId = "00000000-0000-4000-8000-000000000805"

  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "audit-project", "审计项目", "", 1, "global", now, now)
  database.prepare(`INSERT INTO project_services(
    id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    serviceId, projectId, "audit-service", "审计服务", "", "Asia/Shanghai", null, "main", 1, now, now,
  )
  database.prepare(`INSERT INTO admin_users(
    id,username,password_hash,password_salt,password_cost,enabled,auth_version,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?)`).run(userId, "audit-user", "hash", "salt", 16384, 1, 1, now, now)
  database.prepare(`INSERT INTO admin_chat_sessions(id,project_id,service_id,created_by_user_id,title,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(sessionId, projectId, serviceId, userId, "审计会话", now, now)
  database.prepare(`INSERT INTO admin_chat_turns(
    id,session_id,position,question,answer,decision,status,investigation_json,decision_reason,
    decision_confidence,code_revision,code_snapshot_id,code_sync_batch_id,memory_version_refs_json,
    error_code,created_at,updated_at,generation_started_at,completed_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    turnId, sessionId, 1, "问题", "", null, "generating", "[]", null, null, null, null, null, "[]",
    null, now, now, now, null,
  )
  return { database, sessionId, turnId }
}

async function temporaryDatabasePath(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "reply-generation-portable-"))
  temporaryDirectories.push(directory)
  return path.join(directory, name)
}

describe("回复生成审计", () => {
  it("同一回复重试时更新原审计记录，并随所属会话级联清理", async () => {
    const { database, sessionId, turnId } = await seededAdminTurn()
    try {
      const firstId = database.recordReplyGenerationAudit({
        adminChatTurnId: turnId,
        pipelineVersion: "evidence-compose-review-v1",
        mode: "multi_stage",
        evidencePacket: { version: "1", facts: [] },
        baselineAnswer: "基线",
        firstCandidateAnswer: "候选一",
        revisedCandidateAnswer: null,
        reviews: [{ outcome: "revise" }],
        finalSource: "baseline",
        fallbackReason: "审核要求回退",
      })
      const secondId = database.recordReplyGenerationAudit({
        adminChatTurnId: turnId,
        pipelineVersion: "evidence-compose-review-v1",
        mode: "multi_stage",
        evidencePacket: { version: "1", facts: [{ id: "F1" }] },
        baselineAnswer: "基线",
        firstCandidateAnswer: "候选一",
        revisedCandidateAnswer: "候选二",
        reviews: [{ outcome: "approve" }],
        finalSource: "revised_candidate",
        fallbackReason: null,
      })

      expect(secondId).toBe(firstId)
      expect(database.prepare(`SELECT COUNT(*) AS count FROM reply_generation_audits
        WHERE admin_chat_turn_id=?`).get(turnId)).toEqual({ count: 1 })
      expect(database.prepare(`SELECT revised_candidate_answer,final_source,fallback_reason
        FROM reply_generation_audits WHERE id=?`).get(firstId)).toEqual({
        revised_candidate_answer: "候选二",
        final_source: "revised_candidate",
        fallback_reason: null,
      })

      database.prepare("DELETE FROM admin_chat_sessions WHERE id=?").run(sessionId)
      expect(database.prepare("SELECT COUNT(*) AS count FROM reply_generation_audits").get()).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  })

  it("拒绝无归属或同时关联两类回复的审计", async () => {
    const { database, turnId } = await seededAdminTurn()
    try {
      const common = {
        pipelineVersion: "evidence-compose-review-v1",
        mode: "multi_stage" as const,
        evidencePacket: null,
        baselineAnswer: "基线",
        firstCandidateAnswer: null,
        revisedCandidateAnswer: null,
        reviews: [],
        finalSource: "baseline" as const,
        fallbackReason: "旧链路",
      }
      expect(() => database.recordReplyGenerationAudit(common)).toThrow(/必须且只能关联一种回复记录/)
      expect(() => database.recordReplyGenerationAudit({
        ...common,
        supportReplyId: "00000000-0000-4000-8000-000000000899",
        adminChatTurnId: turnId,
      })).toThrow(/必须且只能关联一种回复记录/)
    } finally {
      database.close()
    }
  })

  it("SQLite 导出导入完整保留脱敏后的分阶段审计", async () => {
    const { database, turnId } = await seededAdminTurn()
    const portablePath = await temporaryDatabasePath("portable.sqlite")
    const restored = await RuntimeDatabase.open(await temporaryDatabasePath("restored.sqlite"))
    try {
      database.recordReplyGenerationAudit({
        adminChatTurnId: turnId,
        pipelineVersion: "evidence-compose-review-v1",
        mode: "multi_stage",
        evidencePacket: { version: "1", facts: [{ id: "F1", statement: "已脱敏事实" }] },
        baselineAnswer: "基线",
        firstCandidateAnswer: "候选",
        revisedCandidateAnswer: null,
        reviews: [{ outcome: "approve", reason: "证据完整" }],
        finalSource: "first_candidate",
        fallbackReason: null,
      })
      await new BackupService(database).export(portablePath)
      await new BackupService(restored).import(portablePath)

      expect(restored.prepare(`SELECT pipeline_version,mode,evidence_packet_json,baseline_answer,
        first_candidate_answer,final_source FROM reply_generation_audits WHERE admin_chat_turn_id=?`).get(turnId)).toEqual({
        pipeline_version: "evidence-compose-review-v1",
        mode: "multi_stage",
        evidence_packet_json: JSON.stringify({ version: "1", facts: [{ id: "F1", statement: "已脱敏事实" }] }),
        baseline_answer: "基线",
        first_candidate_answer: "候选",
        final_source: "first_candidate",
      })
    } finally {
      restored.close()
      database.close()
    }
  })

  it("v31 运行库升级到 v32 时创建回复生成审计能力", async () => {
    const filePath = await temporaryDatabasePath("v31.sqlite")
    const current = await RuntimeDatabase.open(filePath)
    current.close()
    const legacy = new DatabaseSync(filePath)
    legacy.exec(`DROP TABLE reply_generation_audits;
      UPDATE metadata SET value='31' WHERE key='schema_version';`)
    legacy.close()

    const migrated = await RuntimeDatabase.open(filePath)
    try {
      expect(migrated.schemaVersion()).toBe(32)
      expect(migrated.prepare(`SELECT sql FROM sqlite_master
        WHERE type='table' AND name='reply_generation_audits'`).get()).toBeTruthy()
    } finally {
      migrated.close()
    }
  })
})
