import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { buildApp } from "../../src/app.js"
import { loadGroupCatalog } from "../../src/catalog/service.js"
import { loadInterfaceDocument } from "../../src/knowledge/interface-documents.js"
import { KnowledgeResolver } from "../../src/knowledge/resolver.js"
import { StaticMagicBookKnowledgeSource } from "../../src/magicbook/json-source.js"
import { MagicBookRepository } from "../../src/magicbook/repository.js"
import { RuntimeAdminService } from "../../src/runtime/admin-service.js"
import { BackupService } from "../../src/runtime/backup-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { RuntimeKnowledgeService } from "../../src/runtime/knowledge-service.js"
import { LocalSecretVault } from "../../src/runtime/secret-vault.js"
import { ConfiguredSecretRedactor } from "../../src/security/dlp.js"
import { baselineOperatorStyleProfile } from "../../src/support/operator-style.js"
import { SupportThreadLifecycleService } from "../../src/support/thread-lifecycle-service.js"
import { SupportThreadQueryService } from "../../src/support/thread-query-service.js"
import { SupportThreadStore } from "../../src/support/thread-store.js"

const snapshot = await new StaticMagicBookKnowledgeSource(
  "config/magicbook-safe-bootstrap.json",
  "knowledge/bootstrap/magicbook-bank-codes-sanitized.json",
).load()
const app = buildApp({
  groupCatalog: await loadGroupCatalog("config/telegram-groups.json"),
  magicBookRepository: new MagicBookRepository(snapshot),
  knowledgeResolver: new KnowledgeResolver(snapshot),
  interfaceDocument: await loadInterfaceDocument("knowledge/bootstrap/interface-docs-sanitized.md"),
})

beforeAll(async () => app.ready())
afterAll(async () => app.close())

describe("第一阶段本机管理 API", () => {
  it("群目录只返回安全别名且Peakpay不存在", async () => {
    const response = await app.inject({ method: "GET", url: "/api/groups" })
    const body = response.json()

    expect(response.statusCode).toBe(200)
    expect(body.groups).toHaveLength(13)
    expect(body.groups.some((group: { platform: string }) => group.platform === "peakpay")).toBe(false)
    expect(response.body).not.toMatch(/telegramChatId|password|token|BEGIN [A-Z ]*PRIVATE KEY/i)
  })

  it("MagicBook状态和印度服务查询不暴露受限参数", async () => {
    const status = await app.inject({ method: "GET", url: "/api/magicbook/status" })
    const service = await app.inject({ method: "GET", url: "/api/magicbook/service/nine" })

    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ serviceCount: 13, regionCount: 7 })
    expect(status.json().services).toHaveLength(13)
    expect(status.json().services[0]).toEqual(expect.objectContaining({
      label: expect.any(String),
      value: expect.any(String),
    }))
    expect(service.json()).toMatchObject({
      found: true,
      region: "印度",
      branch: "uat",
      transactionTypes: [],
      bankCodes: [],
      indiaIfscNotice: true,
    })
    expect(`${status.body}${service.body}`).not.toMatch(/token|password|chatId|baseUrl|callbackIp|documentationUrl|https?:\/\//i)
  })

  it("接口文档按路径查询且UTR补单只允许解释", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/interface-docs/search?q=%2Fapi%2Fxd%2FbindUtr",
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().sections[0]).toMatchObject({
      title: "UTR 补单",
      writeOperation: true,
      explainOnly: true,
    })
    expect(response.body).not.toMatch(/https?:\/\/|BEGIN [A-Z ]*PRIVATE KEY|\b[a-f0-9]{32}\b/i)
  })

  it("安全检查不回显命中的敏感原值", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/security/check",
      payload: { text: "password=hidden-value" },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ allowed: false, safeText: "password=[已脱敏]" })
    expect(response.body).not.toContain("hidden-value")
  })

  it("未知服务和空查询返回简体中文错误", async () => {
    const unknown = await app.inject({ method: "GET", url: "/api/magicbook/service/unknown" })
    const empty = await app.inject({ method: "GET", url: "/api/interface-docs/search?q=" })

    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toEqual({ error: "未找到该服务知识" })
    expect(empty.statusCode).toBe(400)
    expect(empty.json()).toEqual({ error: "查询内容不能为空" })
  })
})

describe("学习来源与观察审计 API", () => {
  it("只允许已配置的数字 ID 开启学习来源，并在问题详情返回观察摘要", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "task-5-admin-api-"))
    const database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
    const vault = await LocalSecretVault.open(path.join(directory, "master.key"))
    const admin = new RuntimeAdminService(database, vault)
    const redactor = new ConfiguredSecretRedactor(database)
    const store = new SupportThreadStore(database, redactor)
    const lifecycle = new SupportThreadLifecycleService(store, { cancel: () => false, cancelClosed: () => 0 })
    const queries = new SupportThreadQueryService(database, store, lifecycle)
    const runtimeApp = buildApp({
      runtimeAdminService: admin,
      runtimeKnowledgeService: {} as never,
      backupService: {} as never,
      supportThreadQueryService: queries,
    })
    const timestamp = "2026-08-11T00:00:00.000Z"
    const projectId = "00000000-0000-4000-8000-000000000001"
    const serviceId = "00000000-0000-4000-8000-000000000002"
    const groupId = "00000000-0000-4000-8000-000000000003"
    try {
      const created = await runtimeApp.inject({
        method: "POST",
        url: "/api/telegram/roles",
        payload: { telegramUserId: "10001", username: null, displayName: "同名运营", role: "operator", canCorrect: false, enabled: true, learningSourceEnabled: false },
      })
      expect(created.statusCode).toBe(201)
      expect(created.json()).toMatchObject({ telegramUserId: "10001", learningSourceEnabled: false })
      const enabled = await runtimeApp.inject({
        method: "PATCH",
        url: `/api/telegram/roles/${created.json().id}`,
        payload: { learningSourceEnabled: true },
      })
      expect(enabled.statusCode).toBe(200)
      expect(enabled.json()).toMatchObject({ telegramUserId: "10001", learningSourceEnabled: true })
      const roles = await runtimeApp.inject({ method: "GET", url: "/api/telegram/roles" })
      expect(roles.json().roles).toEqual([expect.objectContaining({ id: created.json().id, learningSourceEnabled: true })])
      const rejected = await runtimeApp.inject({
        method: "POST",
        url: "/api/telegram/roles",
        payload: { telegramUserId: "同名运营", username: null, displayName: "同名运营", role: "operator", canCorrect: false, enabled: true, learningSourceEnabled: true },
      })
      expect(rejected.statusCode).toBe(400)

      database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "project", "项目", "", 1, "default", timestamp, timestamp)
      database.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(serviceId, projectId, "service", "服务", "", "Asia/Shanghai", null, "main", 1, timestamp, timestamp)
      database.prepare(`INSERT INTO telegram_groups(
        id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
        platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        groupId, "group", "客服群", null, null, projectId, serviceId, 0, "bot", "all", "telegram", "[]", null, null, "database", "default", "support", timestamp, timestamp,
      )
      const event = store.recordEvent({
        groupId, accountId: null, telegramMessageId: "1", replyToMessageId: null, messageThreadId: null,
        senderUserId: "20001", senderUsername: null, senderDisplayName: "运营", senderRole: "operator",
        text: "请看这个问题", attachmentSummary: "", routeStatus: "received", skipReason: null, createdAt: timestamp,
      }).event
      const thread = store.createThread({
        groupId, projectId, serviceId, originBatchId: "00000000-0000-4000-8000-000000000005", settleAt: timestamp, anchorMessageId: "1",
        latestMessageAt: timestamp, summary: "请看这个问题", originEventId: event.id,
      }).thread
      const observationEvent = store.recordEvent({
        groupId, accountId: null, telegramMessageId: "2", replyToMessageId: null, messageThreadId: null,
        senderUserId: "10001", senderUsername: null, senderDisplayName: "同名运营", senderRole: "operator",
        text: "人工参考回复", attachmentSummary: "", routeStatus: "role_skipped", skipReason: null, createdAt: timestamp,
      }).event
      database.prepare(`INSERT INTO learning_source_observations(
        id,message_event_id,source_telegram_user_id,source_role,thread_id,service_id,association_reason,association_confidence,
        takeover_status,classification,risk,processing_status,attempt_count,lock_token,locked_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "00000000-0000-4000-8000-000000000004", observationEvent.id, "10001", "operator", thread.id, serviceId,
        "reply_chain", 1, "cancelled", "reference_reply", "low", "completed", 1, null, null, timestamp, timestamp,
      )
      database.prepare(`INSERT INTO memory_maintenance_runs(
        id,status,scanned_events,created_versions,conflict_count,summary,started_at,finished_at
      ) VALUES (?,?,?,?,?,?,?,?)`).run(
        "00000000-0000-4000-8000-000000000006", "completed", 1, 0, 0, "完成", timestamp, timestamp,
      )
      database.prepare(`INSERT INTO reference_learning_results(
        id,run_id,observation_id,classification,action,risk,outcome,reason_code,
        memory_version_id,operator_style_version_id,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        "00000000-0000-4000-8000-000000000007", "00000000-0000-4000-8000-000000000006",
        "00000000-0000-4000-8000-000000000004", "general", "noop", "medium", "noop", "proposal_noop",
        null, null, timestamp,
      )

      const detail = await runtimeApp.inject({ method: "GET", url: `/api/support-threads/${thread.id}` })
      expect(detail.statusCode).toBe(200)
      expect(detail.json().learningObservations).toEqual([expect.objectContaining({
        associationReason: "reply_chain", threadId: thread.id,
        takeoverStatus: "cancelled", processingStatus: "completed",
        terminalResult: {
          classification: "general", action: "noop", risk: "medium", outcome: "noop", reasonCode: "proposal_noop",
          memoryVersionId: null, operatorStyleVersionId: null, createdAt: timestamp,
        },
      })])
      const observation = detail.json().learningObservations[0] as Record<string, unknown>
      expect(observation).not.toHaveProperty("classification")
      expect(observation).not.toHaveProperty("risk")
      expect(observation).not.toHaveProperty("lockToken")
      expect(observation).not.toHaveProperty("lockedAt")
      expect(observation).not.toHaveProperty("attemptCount")
      expect(observation).not.toHaveProperty("nextAttemptAt")
      expect(observation).not.toHaveProperty("lastError")
    } finally {
      await runtimeApp.close()
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("参考学习审核 API", () => {
  it("集中返回观察、代码证据、来源线程和风格版本且高风险只经人工审核生效", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "task-8-admin-api-"))
    const database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
    const redactor = new ConfiguredSecretRedactor(database)
    const knowledge = new RuntimeKnowledgeService(database, redactor)
    const store = new SupportThreadStore(database, redactor)
    const runtimeApp = buildApp({
      runtimeKnowledgeService: knowledge,
      backupService: new BackupService(database),
    })
    const timestamp = "2026-08-11T00:00:00.000Z"
    const projectId = "00000000-0000-4000-8000-000000000801"
    const serviceId = "00000000-0000-4000-8000-000000000802"
    const groupId = "00000000-0000-4000-8000-000000000803"
    try {
      database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "project", "项目", "", 1, "global", timestamp, timestamp)
      database.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(serviceId, projectId, "service", "服务", "", "Asia/Shanghai", null, "main", 1, timestamp, timestamp)
      database.prepare(`INSERT INTO telegram_groups(
        id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
        platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        groupId, "group", "客服群", null, null, projectId, serviceId, 0, "bot", "all", "telegram", "[]", null, null,
        "database", "global", "support", timestamp, timestamp,
      )
      database.prepare(`INSERT INTO telegram_roles(
        id,telegram_user_id,username,display_name,role,can_correct,enabled,learning_source_enabled,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        "00000000-0000-4000-8000-000000000804", "10001", null, "人工来源", "operator", 0, 1, 1, timestamp, timestamp,
      )
      const event = store.recordEvent({
        groupId, accountId: null, telegramMessageId: "1", replyToMessageId: null, messageThreadId: null,
        senderUserId: "10001", senderUsername: null, senderDisplayName: "人工来源", senderRole: "operator",
        text: "人工原文不能进入在线提示词", attachmentSummary: "", routeStatus: "role_skipped", skipReason: null,
        createdAt: timestamp,
      }).event
      const thread = store.createThread({
        groupId, projectId, serviceId, originBatchId: "00000000-0000-4000-8000-000000000805",
        settleAt: timestamp, anchorMessageId: "1", latestMessageAt: timestamp, summary: "安全问题",
        originEventId: event.id,
      }).thread
      const observationId = "00000000-0000-4000-8000-000000000806"
      database.prepare(`INSERT INTO learning_source_observations(
        id,message_event_id,source_telegram_user_id,source_role,thread_id,service_id,association_reason,association_confidence,
        takeover_status,classification,risk,processing_status,attempt_count,lock_token,locked_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        observationId, event.id, "10001", "operator", thread.id, serviceId, "direct_question", 1, "cancelled",
        "reference_reply", "high", "completed", 1, null, null, timestamp, timestamp,
      )
      const snapshotId = "00000000-0000-4000-8000-000000000807"
      const submitted = knowledge.submitReferenceObservation({
        action: "add",
        title: "生产配置修改规则",
        content: "生产配置修改必须人工确认",
        scope: "global",
        region: null,
        branch: "main",
        risk: "high",
        confidence: 0.9,
        actor: "人工参考学习",
        observationIds: [observationId],
        snapshotId,
        codeRevision: "abc123",
        codeEvidencePaths: ["java-project/src/main/java/ConfigGuard.java"],
      })
      expect(submitted.memory.status).toBe("candidate")
      database.prepare(`INSERT INTO memory_maintenance_runs(
        id,status,scanned_events,created_versions,conflict_count,summary,started_at,finished_at
      ) VALUES (?,?,?,?,?,?,?,?)`).run(
        "00000000-0000-4000-8000-000000000809", "completed", 1, 1, 0, "完成", timestamp, timestamp,
      )
      database.prepare(`INSERT INTO reference_learning_results(
        id,run_id,observation_id,classification,action,risk,outcome,reason_code,
        memory_version_id,operator_style_version_id,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        "00000000-0000-4000-8000-000000000810", "00000000-0000-4000-8000-000000000809", observationId,
        "business_rule", "add", "high", "candidate", "memory_candidate", submitted.memory.versionId, null, timestamp,
      )

      database.prepare(`INSERT INTO operator_style_versions(
        id,version_number,profile_json,status,sample_count,source_user_count,thread_count,created_at,activated_at,superseded_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        "00000000-0000-4000-8000-000000000808", 1, JSON.stringify({
          ...baselineOperatorStyleProfile,
          statistics: { ...baselineOperatorStyleProfile.statistics, sampleCount: 20, sourceUserCount: 2, threadCount: 5 },
        }), "active", 20, 2, 5, timestamp, timestamp, null,
      )

      const observations = await runtimeApp.inject({
        method: "GET",
        url: "/api/learning-observations?processingStatus=completed&classification=business_rule&risk=high",
      })
      expect(observations.statusCode).toBe(200)
      expect(observations.json().items).toEqual([expect.objectContaining({
        id: observationId,
        threadId: thread.id,
        processingStatus: "completed",
        terminalResult: {
          classification: "business_rule", action: "add", risk: "high", outcome: "candidate",
          reasonCode: "memory_candidate", memoryVersionId: submitted.memory.versionId,
          operatorStyleVersionId: null, createdAt: timestamp,
        },
      })])
      expect(observations.body).not.toContain("人工原文不能进入在线提示词")
      expect(observations.body).not.toMatch(/lockToken|lockedAt|attemptCount|currentRunId|runId|summary|classification":"reference_reply/u)

      const detail = await runtimeApp.inject({ method: "GET", url: `/api/memories/${submitted.memory.id}` })
      expect(detail.statusCode).toBe(200)
      expect(detail.json().evidence).toEqual({
        codeEvidence: [{ path: "java-project/src/main/java/ConfigGuard.java", codeRevision: "abc123", snapshotId }],
        sourceThreads: [{ observationId, threadId: thread.id }],
      })

      const styles = await runtimeApp.inject({ method: "GET", url: "/api/operator-style-versions" })
      expect(styles.statusCode).toBe(200)
      expect(styles.json().items).toEqual([expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000808",
        version: 1,
        status: "active",
      })])

      const activated = await runtimeApp.inject({
        method: "PATCH",
        url: `/api/memories/${submitted.memory.id}/status`,
        payload: { status: "active", actor: "后台管理员" },
      })
      expect(activated.statusCode).toBe(200)
      expect(activated.json()).toMatchObject({ risk: "high", status: "active" })
      const disabled = await runtimeApp.inject({
        method: "PATCH",
        url: `/api/memories/${submitted.memory.id}/status`,
        payload: { status: "disabled", actor: "后台管理员" },
      })
      expect(disabled.json().status).toBe("disabled")
      const restored = await runtimeApp.inject({
        method: "PATCH",
        url: `/api/memories/${submitted.memory.id}/status`,
        payload: { status: "active", actor: "后台管理员" },
      })
      expect(restored.json().status).toBe("active")
    } finally {
      await runtimeApp.close()
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
