import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import type { AnswerDecision } from "../../src/codex/schemas.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import {
  SupportInvestigationService,
  type SupportReplyPipelineAudit,
} from "../../src/support/investigation-service.js"
import { baselineOperatorStyleProfile } from "../../src/support/operator-style.js"

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url))
const scriptPath = path.join(repositoryRoot, "scripts/run-reply-regression.mjs")
const scriptUrl = pathToFileURL(scriptPath).href
const buildScriptPath = path.join(repositoryRoot, "scripts/build-server.mjs")
const buildScriptUrl = pathToFileURL(buildScriptPath).href
const temporaryDirectories: string[] = []
const invalidDependencyNodes = ["external_symlink", "dangling_symlink", "oversized_file", "special_node"] as const

type ChildResult = { status: number | null; stdout: string; stderr: string }

function runNode(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout += chunk })
    child.stderr.on("data", (chunk: string) => { stderr += chunk })
    child.once("error", reject)
    child.once("close", (status) => resolve({ status, stdout, stderr }))
  })
}

function evaluateModule(source: string): Promise<ChildResult> {
  return runNode(["--input-type=module", "--eval", `
    const regression = await import(${JSON.stringify(scriptUrl)});
    ${source}
  `])
}

function caseId(source: "support" | "admin", id: string): string {
  return createHash("sha256").update(`${source}:${id}`).digest("hex").slice(0, 12)
}

async function createRuntimeSnapshotFixture(): Promise<{
  root: string
  packageContents: string
  packagePath: string
  databaseModulePath: string
  dependencyPath: string
  sentinelPath: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), "reply-regression-runtime-snapshot-"))
  temporaryDirectories.push(root)
  await mkdir(path.join(root, "src"), { recursive: true })
  await mkdir(path.join(root, "dist"), { recursive: true })
  await mkdir(path.join(root, "scripts"), { recursive: true })
  const packageContents = JSON.stringify({ type: "module", version: "2.2.3" })
  const packagePath = path.join(root, "package.json")
  await writeFile(packagePath, packageContents)
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2023" } }))
  await writeFile(path.join(root, "tsconfig.build.json"), JSON.stringify({ extends: "./tsconfig.json" }))
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  await writeFile(path.join(root, "scripts/build-server.mjs"), await readFile(buildScriptPath))
  await writeFile(path.join(root, "scripts/run-reply-regression.mjs"), await readFile(scriptPath))

  const dependencyDirectory = path.join(root, "node_modules/.fixture-store/fixture-dependency")
  const zodDirectory = path.join(root, "node_modules/zod")
  await mkdir(dependencyDirectory, { recursive: true })
  await mkdir(zodDirectory, { recursive: true })
  await writeFile(path.join(dependencyDirectory, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }))
  const dependencyPath = path.join(dependencyDirectory, "index.js")
  await writeFile(dependencyPath, "export const marker = 'validated-dependency'\n")
  await symlink(".fixture-store/fixture-dependency", path.join(root, "node_modules/fixture-dependency"))
  await writeFile(path.join(zodDirectory, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }))
  await writeFile(path.join(zodDirectory, "index.js"), "export const z = { marker: 'validated-zod' }\n")

  const modules = [
    ["server", "export const server = true\n"],
    ["version", "export const APP_VERSION = '2.2.3'\n"],
    ["runtime/database", "import { marker } from 'fixture-dependency'\nexport class RuntimeDatabase { static marker = marker }\n"],
    ["runtime/secret-vault", "export class LocalSecretVault {}\n"],
    ["runtime/model-config-service", "export class ModelConfigService {}\n"],
    ["runtime/knowledge-service", "export class RuntimeKnowledgeService {}\n"],
    ["security/dlp", "export class ConfiguredSecretRedactor {}\n"],
    ["git-sync/project-service", "export class ProjectCodeSyncService {}\n"],
    ["diagnostics/resource-broker", "export class ReadonlyResourceBroker {}\n"],
    ["diagnostics/readonly-agent-tool-broker", "export class ReadonlyAgentToolBroker {}\n"],
    ["models/direct-api/direct-api-adapter", "export class DirectApiAdapter {}\n"],
    ["codex/executor", "export class CodexExecutor {}\n"],
    ["support/agent", "export class CodexSupportDecisionAgent {}\n"],
    ["support/investigation-service", "export class SupportInvestigationService {}\n"],
    ["support/resource-workspace", "export class ResourceWorkspace {}\n"],
    ["admin-chat/worker", "export function latestAdminChatMessage(value) { return value }\n"],
  ] as const
  for (const [modulePath, source] of modules) {
    await mkdir(path.join(root, "src", path.dirname(modulePath)), { recursive: true })
    await mkdir(path.join(root, "dist", path.dirname(modulePath)), { recursive: true })
    await writeFile(path.join(root, "src", `${modulePath}.ts`), source)
    await writeFile(path.join(root, "dist", `${modulePath}.js`), source)
  }
  const manifestResult = await runNode(["--input-type=module", "--eval", `
    const builder = await import(${JSON.stringify(buildScriptUrl)});
    await builder.writeServerBuildManifest({ rootDirectory: ${JSON.stringify(root)} });
  `])
  expect(manifestResult.status).toBe(0)
  return {
    root,
    packageContents,
    packagePath,
    databaseModulePath: path.join(root, "dist/runtime/database.js"),
    dependencyPath,
    sentinelPath: path.join(root, "unbound-module-executed"),
  }
}

async function realIgnorePipelineFixture(): Promise<{ decision: AnswerDecision; pipelineAudit: SupportReplyPipelineAudit }> {
  const facts: AnswerDecision["evidencePacket"]["facts"] = Array.from({ length: 13 }, (_, index) => ({
    id: `F${index + 1}`,
    statement: `当前代码事实 ${index + 1} 不会发送`,
    provenance: "code",
    evidenceSource: "code",
    evidence: `当前发布代码快照 ${index + 1}`,
    certainty: "confirmed",
    outboundSafe: true,
    subjectKind: "general",
    businessType: "not_applicable",
    identifiers: [],
    associationId: null,
    dependsOnFactIds: [],
  }))
  const baseline: AnswerDecision = {
    decision: "ignore",
    escalationType: "none",
    humanOperation: null,
    answer: "",
    quote: null,
    reason: "无需客服回复",
    confidence: 0.9,
    usedMemoryVersionIds: [],
    answerClaims: facts.map((fact) => ({
      factId: fact.id,
      statement: fact.statement,
      provenance: fact.provenance,
      evidenceSource: fact.evidenceSource,
      evidence: fact.evidence,
    })),
    responsibility: { party: "not_applicable", certainty: "not_applicable", evidenceSources: [], factIds: [] },
    interaction: {
      sentiment: "neutral",
      situation: "new_request",
      underlyingNeed: "无需回复",
      responseStrategy: "direct_answer",
    },
    investigation: {
      summary: "模型自报轨迹，不是父进程 observation",
      steps: [{
        source: "code",
        title: "模型自报代码检查",
        status: "confirmed",
        evidence: "当前发布代码快照",
        conclusion: "不应绑定为可信 observation",
      }],
    },
    evidencePacket: {
      version: "2",
      communication: { intent: "ignore", recipient: null, desiredOutcome: "不生成对外回复" },
      facts,
      associations: [],
      requiredAnswerPoints: [],
      unknowns: [],
      handlingNotes: [],
      reviewLevel: "standard",
    },
  }
  const passthroughRedactor = {
    redact: (value: string) => ({ text: value, changed: false, categories: [] }),
    assertSafeOutbound: (value: string) => ({ allowed: true, safeText: value, categories: [] }),
  }
  const service = new SupportInvestigationService({
    redactor: passthroughRedactor,
    agent: { decide: async () => baseline },
  } as never)
  const pipeline = service as unknown as {
    runReplyPipeline: (
      request: unknown,
      decision: AnswerDecision,
      allowedMemoryIds: Set<string>,
      signal: AbortSignal,
    ) => Promise<{ decision: AnswerDecision; audit: SupportReplyPipelineAudit }>
  }
  const result = await pipeline.runReplyPipeline({}, baseline, new Set(), new AbortController().signal)
  return { decision: result.decision, pipelineAudit: result.audit }
}

async function seedReplayDatabase(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "reply-regression-live-fixture-"))
  temporaryDirectories.push(directory)
  const databasePath = path.join(directory, "runtime.sqlite")
  const database = await RuntimeDatabase.open(databasePath)
  const projectId = "replay-project"
  const serviceId = "replay-service"
  const groupId = "replay-group"
  const threadId = "deva-thread"
  const correctedReplyId = "deva-corrected-reply"
  const invalidCorrectionReplyId = "invalid-correction-reply"
  const legacyReplyId = "legacy-reply"
  const times = {
    first: "2026-08-20T10:00:00.000Z",
    priorReply: "2026-08-20T10:00:10.000Z",
    screenshot: "2026-08-20T10:00:20.000Z",
    correctedReply: "2026-08-20T10:00:30.000Z",
    later: "2026-08-20T10:01:00.000Z",
    afterCorrection: "2026-08-20T10:02:00.000Z",
  }
  try {
    database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "replay-project", "回放项目", "", 1, "replay-scope", times.first, times.first)
    database.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      serviceId, projectId, "deva", "Deva 服务", "", "Asia/Shanghai", null, "main", 1, times.first, times.first,
    )
    database.prepare(`INSERT INTO telegram_groups(
      id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
      platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      groupId, "deva-group", "Deva 客服群", "-10001", null, projectId, serviceId, 1, "bot", "all",
      "telegram", "[]", "main", null, "database", "replay-scope", "support", times.first, times.first,
    )
    database.prepare(`INSERT INTO support_threads(
      id,group_id,project_id,service_id,status,revision,settle_at,anchor_message_id,latest_message_at,summary,
      operator_style_profile_json,answer_reply_style,answer_include_ai_memory,answer_include_interface_docs,
      answer_include_magic_book,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      threadId, groupId, projectId, serviceId, "answered", 3, times.correctedReply, "101", times.later, "Deva 多消息截图问题",
      JSON.stringify({ ...baselineOperatorStyleProfile, shortSentenceMaxChars: 41 }), "unrestricted", 0, 1, 0,
      times.first, times.later,
    )

    const insertEvent = database.prepare(`INSERT INTO support_message_events(
      id,group_id,account_id,telegram_message_id,reply_to_message_id,message_thread_id,sender_user_id,sender_username,
      sender_display_name,sender_role,safe_text,attachment_summary,ingest_batch_id,route_status,skip_reason,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    insertEvent.run("event-101", groupId, null, "101", null, null, "501", "deva-operator", "运营", null,
      "Deva 这笔订单为什么没更新", "", null, "routed", null, times.first)
    insertEvent.run("event-102", groupId, null, "102", null, null, "501", "deva-operator", "运营", null,
      "截图补充如下", "image/png", null, "routed", null, times.screenshot)
    insertEvent.run("event-103", groupId, null, "103", null, null, "501", "deva-operator", "运营", null,
      "目标回复发送后的补充，绝不能混入", "", null, "routed", null, times.later)
    const insertThreadMessage = database.prepare(`INSERT INTO support_thread_messages(
      thread_id,message_event_id,relation,question_fragment,position,created_at
    ) VALUES (?,?,?,?,?,?)`)
    insertThreadMessage.run(threadId, "event-101", "origin", "Deva 这笔订单为什么没更新", 0, times.first)
    insertThreadMessage.run(threadId, "event-102", "supplement", "截图补充如下", 1, times.screenshot)
    insertThreadMessage.run(threadId, "event-103", "supplement", "目标回复发送后的补充，绝不能混入", 2, times.later)
    database.prepare(`INSERT INTO support_message_attachments(
      id,message_event_id,file_name,mime_type,file_size,kind,storage_path,extracted_text,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      "live-image", "event-102", "deva-shot.png", "image/png", 321, "image", "/tmp/deva-shot.png",
      "截图显示上游已成功", times.screenshot,
    )
    database.prepare(`INSERT INTO support_message_attachments(
      id,message_event_id,file_name,mime_type,file_size,kind,storage_path,extracted_text,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      "later-image", "event-103", "later-shot.png", "image/png", 654, "image", "/tmp/later-shot.png",
      "回复后才出现的附件", times.later,
    )

    const insertReply = database.prepare(`INSERT INTO support_replies(
      id,thread_id,input_revision,group_id,project_id,service_id,telegram_message_id,sender_user_id,service,
      decision,status,created_at,updated_at,corrected_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    insertReply.run("prior-reply", threadId, 1, groupId, projectId, serviceId, "101", "501", "deva",
      "reply", "replied", times.priorReply, times.priorReply, null)
    insertReply.run("late-sent-reply", threadId, 1, groupId, projectId, serviceId, "101", "501", "deva",
      "reply", "replied", times.priorReply, times.later, null)
    insertReply.run(correctedReplyId, threadId, 2, groupId, projectId, serviceId, "102", "501", "deva",
      "reply", "corrected", times.correctedReply, times.correctedReply, times.correctedReply)
    insertReply.run(invalidCorrectionReplyId, null, 1, groupId, projectId, serviceId, "201", "501", "deva",
      "reply", "corrected", times.correctedReply, times.later, times.later)
    insertReply.run(legacyReplyId, null, 1, groupId, projectId, serviceId, "301", "501", "deva",
      "reply", "replied", times.first, times.first, null)
    const insertPayload = database.prepare(`INSERT INTO support_reply_payloads(reply_id,question,answer,quote_text,has_attachment)
      VALUES (?,?,?,?,?)`)
    insertPayload.run("prior-reply", "Deva 这笔订单为什么没更新", "先前已回复的上下文", null, 0)
    insertPayload.run("late-sent-reply", "Deva 这笔订单为什么没更新", "发送跨过目标时点不应出现", null, 0)
    insertPayload.run(correctedReplyId, "Deva 这笔订单为什么没更新\n截图补充如下", "原来的错误回答不得复用", null, 0)
    insertPayload.run(invalidCorrectionReplyId, "无法解析纠正", "同样是错误历史回答", null, 0)
    insertPayload.run(legacyReplyId, "旧版附件问题", "旧版有效回答", null, 0)
    database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "prior-reply-ownership", null, groupId, "-10001", "9001", threadId, serviceId, "prior-reply",
      null, "support_reply", "sent", "prior-reply-request", "a".repeat(64), "101", times.priorReply, times.priorReply,
    )
    database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "late-sent-reply-ownership", null, groupId, "-10001", "9002", threadId, serviceId, "late-sent-reply",
      null, "support_reply", "sent", "late-sent-reply-request", "b".repeat(64), "101", times.priorReply, times.later,
    )
    database.prepare(`INSERT INTO support_attachments(
      id,reply_id,file_name,mime_type,file_size,kind,storage_path,extracted_text,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      "legacy-attachment", legacyReplyId, "legacy.txt", "text/plain", 10, "text", "/tmp/legacy.txt", "旧版附件正文", times.first,
    )
    const insertCorrection = database.prepare(`INSERT INTO memory_events(
      id,type,source_ref,fact_id,reply_record_id,content,scope,region,branch,code_revision,risk,confidence,actor,occurred_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    insertCorrection.run("correction-old", "correction", correctedReplyId, null, correctedReplyId,
      "原问题：旧\n人工正确回答：旧纠正回答\n纠正原因：已更新", "replay-scope", null, null, null, "low", 1, "human", times.priorReply)
    insertCorrection.run("correction-latest", "correction", correctedReplyId, null, correctedReplyId,
      "原问题：Deva\n人工正确回答：最新人工正确回答\n第二行也属于回答\n纠正原因：以人工结论为准", "replay-scope", null, null, null, "low", 1, "human", times.correctedReply)
    insertCorrection.run("correction-invalid", "correction", invalidCorrectionReplyId, null, invalidCorrectionReplyId,
      "这不是可验证的纠正结构", "replay-scope", null, null, null, "low", 1, "human", times.later)
    insertCorrection.run("prior-reply-later-correction", "correction", "prior-reply", null, "prior-reply",
      "原问题：Deva\n人工正确回答：事后才录入的人工纠正\n纠正原因：不应抹掉历史发送事实",
      "replay-scope", null, null, null, "low", 1, "human", times.afterCorrection)
    database.prepare(`UPDATE support_replies SET status='corrected',updated_at=?,corrected_at=? WHERE id=?`).run(
      times.afterCorrection, times.afterCorrection, "prior-reply",
    )
  } finally {
    database.close()
  }
  return databasePath
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("历史回复聚焦回放", () => {
  it("--help 在没有 dist 和位置参数时直接成功并说明只读、无 Telegram 边界", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reply-regression-help-"))
    temporaryDirectories.push(directory)

    const result = await runNode([scriptPath, "--help"], { cwd: directory })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("--focus-case-id <12位hash>")
    expect(result.stdout).toContain("只读打开 SQLite 副本")
    expect(result.stdout).toContain("不会发送 Telegram")
  })

  it("构建 manifest 用内容清单拒绝 touch 过的旧 dist、单字节篡改、缺 manifest 和新增源码", async () => {
    const fixture = async (name: string, writeManifest = true) => {
      const root = await mkdtemp(path.join(tmpdir(), `reply-regression-artifact-${name}-`))
      temporaryDirectories.push(root)
      await mkdir(path.join(root, "src"), { recursive: true })
      await mkdir(path.join(root, "dist"), { recursive: true })
      await mkdir(path.join(root, "scripts"), { recursive: true })
      await mkdir(path.join(root, "runtime"), { recursive: true })
      await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", version: "2.2.3" }))
      await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2023" } }))
      await writeFile(path.join(root, "tsconfig.build.json"), JSON.stringify({ extends: "./tsconfig.json" }))
      await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
      await writeFile(path.join(root, "scripts/build-server.mjs"), await readFile(buildScriptPath))
      await writeFile(path.join(root, "scripts/run-reply-regression.mjs"), await readFile(scriptPath))
      await writeFile(path.join(root, "src/server.ts"), "export const server = true\n")
      await writeFile(path.join(root, "src/types.d.ts"), "declare const buildTypeMarker: unique symbol\n")
      await writeFile(path.join(root, "src/version.ts"), "export const APP_VERSION = '2.2.3'\n")
      await writeFile(path.join(root, "src/feature.ts"), "export const feature = 'current'\n")
      await writeFile(path.join(root, "dist/server.js"), "export const server = true\n")
      await writeFile(path.join(root, "dist/version.js"), "export const APP_VERSION = '2.2.3'\n")
      await writeFile(path.join(root, "dist/feature.js"), "export const feature = 'built'\n")
      if (writeManifest) {
        const sentinelPath = path.join(root, "manifest-hardlink-sentinel")
        const manifestPath = path.join(root, "dist/.reply-regression-build-manifest.json")
        await writeFile(sentinelPath, "old-manifest-inode")
        await chmod(sentinelPath, 0o640)
        await link(sentinelPath, manifestPath)
        const buildResult = await runNode(["--input-type=module", "--eval", `
          const builder = await import(${JSON.stringify(buildScriptUrl)});
          await builder.writeServerBuildManifest({ rootDirectory: ${JSON.stringify(root)} });
        `])
        expect(buildResult.status).toBe(0)
        expect(await readFile(sentinelPath, "utf8")).toBe("old-manifest-inode")
        expect((await stat(sentinelPath)).mode & 0o777).toBe(0o640)
        expect((await stat(manifestPath)).ino).not.toBe((await stat(sentinelPath)).ino)
        expect((await stat(manifestPath)).mode & 0o777).toBe(0o600)
      }
      return root
    }
    const validRoot = await fixture("valid")
    const staleRoot = await fixture("stale")
    const tamperedRoot = await fixture("tampered")
    const missingManifestRoot = await fixture("missing-manifest", false)
    const newSourceRoot = await fixture("new-source")
    const mismatchRoot = await fixture("mismatch")
    const changedRunnerRoot = await fixture("changed-runner")
    const untrackedDistRoot = await fixture("untracked-dist")
    const extraOutputRoot = await fixture("extra-output", false)
    const symlinkOutputRoot = await fixture("symlink-output", false)
    const compilerFailureRoot = await fixture("compiler-failure", false)
    const compilerMutationRoot = await fixture("compiler-mutation", false)
    const runnerRaceRoot = await fixture("runner-race")
    await writeFile(path.join(staleRoot, "src/feature.ts"), "export const feature = 'new-source-after-old-build'\n")
    const future = new Date("2030-01-01T00:00:00.000Z")
    await utimes(path.join(staleRoot, "dist/feature.js"), future, future)
    await writeFile(path.join(tamperedRoot, "dist/feature.js"), "export const feature = 'builu'\n")
    await utimes(path.join(tamperedRoot, "dist/feature.js"), future, future)
    await writeFile(path.join(newSourceRoot, "src/new-module.ts"), "export const added = true\n")
    await writeFile(path.join(mismatchRoot, "package.json"), JSON.stringify({ type: "module", version: "2.2.4" }))
    await writeFile(path.join(changedRunnerRoot, "scripts/run-reply-regression.mjs"), "throw new Error('changed runner')\n")
    await writeFile(path.join(untrackedDistRoot, "dist/untracked-config.json"), "{\"untracked\":true}\n")
    await writeFile(path.join(extraOutputRoot, "dist/old-entry.js"), "export const stale = true\n")
    const externalOutput = path.join(symlinkOutputRoot, "external-feature.js")
    await writeFile(externalOutput, "export const feature = 'external'\n")
    await rm(path.join(symlinkOutputRoot, "dist/feature.js"))
    await symlink(externalOutput, path.join(symlinkOutputRoot, "dist/feature.js"))
    await mkdir(path.join(compilerFailureRoot, "node_modules/typescript/bin"), { recursive: true })
    await writeFile(path.join(compilerFailureRoot, "node_modules/typescript/bin/tsc"), "process.exitCode = 23\n")
    await mkdir(path.join(compilerMutationRoot, "node_modules/typescript/bin"), { recursive: true })
    await writeFile(path.join(compilerMutationRoot, "node_modules/typescript/bin/tsc"), `
      const fs = await import("node:fs/promises");
      const path = (await import("node:path")).default;
      const outputDirectory = process.argv[process.argv.indexOf("--outDir") + 1];
      await fs.mkdir(outputDirectory, { recursive: true });
      await fs.writeFile(path.join(outputDirectory, "feature.js"), "export const feature = 'compiled-before-mutation'\\n");
      await fs.writeFile(path.join(outputDirectory, "server.js"), "export const server = true\\n");
      await fs.writeFile(path.join(outputDirectory, "version.js"), "export const APP_VERSION = '2.2.3'\\n");
      await fs.writeFile(path.join(process.cwd(), "src/feature.ts"), "export const feature = 'mutated-during-build'\\n");
    `)
    const databasePath = path.join(missingManifestRoot, "source.sqlite")
    const masterKeyPath = path.join(missingManifestRoot, "master.key")
    const reportPath = path.join(missingManifestRoot, "report.json")
    await writeFile(databasePath, "immutable-database")
    await writeFile(masterKeyPath, Buffer.alloc(32, 3))

    const result = await evaluateModule(`
      const roots = ${JSON.stringify([
        validRoot, staleRoot, tamperedRoot, missingManifestRoot, newSourceRoot, mismatchRoot,
        changedRunnerRoot, untrackedDistRoot,
      ])};
      const outcomes = [];
      for (const rootDirectory of roots) {
        try {
          await regression.assertRegressionArtifactConsistency({ rootDirectory });
          outcomes.push("ok");
        } catch (error) {
          outcomes.push(error instanceof Error ? error.message : "unknown");
        }
      }
      process.stdout.write(JSON.stringify(outcomes));
    `)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      "ok",
      "回归运行产物与当前源码或版本不一致，请先重新构建",
      "回归运行产物与当前源码或版本不一致，请先重新构建",
      "回归运行产物与当前源码或版本不一致，请先重新构建",
      "回归运行产物与当前源码或版本不一致，请先重新构建",
      "回归运行产物与当前源码或版本不一致，请先重新构建",
      "回归运行产物与当前源码或版本不一致，请先重新构建",
      "回归运行产物与当前源码或版本不一致，请先重新构建",
    ])

    const manifest = JSON.parse(await readFile(
      path.join(validRoot, "dist/.reply-regression-build-manifest.json"), "utf8",
    )) as { version: number; inputs: Array<{ path: string; sha256: string }>; outputs: Array<{ path: string; sha256: string }> }
    expect(manifest.version).toBe(1)
    expect(manifest.inputs.map((item) => item.path)).toEqual([
      "package.json", "pnpm-lock.yaml", "scripts/build-server.mjs", "scripts/run-reply-regression.mjs",
      "src/feature.ts", "src/server.ts", "src/types.d.ts", "src/version.ts", "tsconfig.build.json", "tsconfig.json",
    ])
    expect(manifest.outputs.map((item) => item.path)).toEqual([
      "dist/feature.js", "dist/server.js", "dist/version.js",
    ])
    expect(manifest.outputs.find((item) => item.path === "dist/feature.js")?.sha256).toBe(
      createHash("sha256").update("export const feature = 'built'\n").digest("hex"),
    )

    const rejectedBuildInputs = await runNode(["--input-type=module", "--eval", `
      const builder = await import(${JSON.stringify(buildScriptUrl)});
      const roots = ${JSON.stringify([extraOutputRoot, symlinkOutputRoot])};
      const outcomes = [];
      for (const rootDirectory of roots) {
        try {
          await builder.writeServerBuildManifest({ rootDirectory });
          outcomes.push("allowed");
        } catch (error) {
          outcomes.push(error instanceof Error ? error.message : "unknown");
        }
      }
      process.stdout.write(JSON.stringify(outcomes));
    `])
    expect(rejectedBuildInputs.status).toBe(0)
    expect(JSON.parse(rejectedBuildInputs.stdout)).toEqual([
      "服务端 dist 清单与当前源码不一致",
      "服务端构建清单不允许符号链接",
    ])
    for (const root of [extraOutputRoot, symlinkOutputRoot]) {
      await expect(stat(path.join(root, "dist/.reply-regression-build-manifest.json")))
        .rejects.toMatchObject({ code: "ENOENT" })
    }

    const compilerFailure = await runNode(["--input-type=module", "--eval", `
      const builder = await import(${JSON.stringify(buildScriptUrl)});
      const exitCode = await builder.buildServer({ rootDirectory: ${JSON.stringify(compilerFailureRoot)} });
      process.stdout.write(String(exitCode));
    `])
    expect(compilerFailure.status).toBe(0)
    expect(compilerFailure.stdout).toBe("23")
    expect(await readFile(path.join(compilerFailureRoot, "dist/feature.js"), "utf8"))
      .toBe("export const feature = 'built'\n")
    await expect(stat(path.join(compilerFailureRoot, "dist/.reply-regression-build-manifest.json")))
      .rejects.toMatchObject({ code: "ENOENT" })

    const compilerMutation = await runNode(["--input-type=module", "--eval", `
      const builder = await import(${JSON.stringify(buildScriptUrl)});
      try {
        await builder.buildServer({ rootDirectory: ${JSON.stringify(compilerMutationRoot)} });
        process.stdout.write("allowed");
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : "unknown");
      }
    `])
    expect(compilerMutation.status).toBe(0)
    expect(compilerMutation.stdout).toBe("服务端构建期间输入发生变化，已拒绝发布产物")
    expect(await readFile(path.join(compilerMutationRoot, "dist/feature.js"), "utf8"))
      .toBe("export const feature = 'built'\n")
    await expect(stat(path.join(compilerMutationRoot, "dist/.reply-regression-build-manifest.json")))
      .rejects.toMatchObject({ code: "ENOENT" })

    const runnerRace = await runNode(["--input-type=module", "--eval", `
      const fs = await import("node:fs/promises");
      const { pathToFileURL } = await import("node:url");
      const runnerPath = ${JSON.stringify(path.join(runnerRaceRoot, "scripts/run-reply-regression.mjs"))};
      const executingV1 = await import(pathToFileURL(runnerPath).href);
      const v1Contents = await fs.readFile(runnerPath, "utf8");
      await fs.writeFile(runnerPath, v1Contents + '\\nexport const runnerGeneration = "v2"\\n');
      const builder = await import(${JSON.stringify(buildScriptUrl)});
      await builder.writeServerBuildManifest({ rootDirectory: ${JSON.stringify(runnerRaceRoot)} });
      try {
        const version = await executingV1.assertRegressionArtifactConsistency({
          rootDirectory: ${JSON.stringify(runnerRaceRoot)},
        });
        process.stdout.write(JSON.stringify({ version, executingRunnerHasV2: "runnerGeneration" in executingV1 }));
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : "unknown");
      }
    `])
    expect(runnerRace.status).toBe(0)
    expect(runnerRace.stderr).toBe("")
    expect(runnerRace.stdout).toBe("回归运行产物与当前源码或版本不一致，请先重新构建")

    const startup = await runNode([
      scriptPath, databasePath, masterKeyPath, path.join(missingManifestRoot, "runtime"), reportPath, "1",
    ], { cwd: missingManifestRoot })
    expect(startup.status).toBe(1)
    expect(startup.stderr).toBe("回归运行产物与当前源码或版本不一致，请先重新构建\n")
    expect(await readFile(databasePath, "utf8")).toBe("immutable-database")
    await expect(readFile(reportPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["replace", "delete"] as const)("校验后 live package.json %s 仍只加载已绑定快照", async (packageMutation) => {
    const {
      root,
      packageContents,
      packagePath,
      databaseModulePath,
      dependencyPath,
      sentinelPath,
    } = await createRuntimeSnapshotFixture()
    const result = await evaluateModule(`
      const fs = await import("node:fs/promises");
      const path = (await import("node:path")).default;
      const loaded = await regression.loadRegressionRuntimeModules({
        rootDirectory: ${JSON.stringify(root)},
        afterArtifactConsistency: async () => {
          await fs.writeFile(
            ${JSON.stringify(databaseModulePath)},
            'import { writeFile } from "node:fs/promises";\\n'
              + 'await writeFile(${JSON.stringify(sentinelPath)}, "executed");\\n'
              + 'export class RuntimeDatabase { static marker = "unbound-database" }\\n',
          );
          ${packageMutation === "replace"
            ? `
              await fs.writeFile(${JSON.stringify(packagePath)}, ${JSON.stringify(JSON.stringify({ type: "commonjs", version: "2.2.3" }))});
              await fs.writeFile(${JSON.stringify(dependencyPath)}, "export const marker = 'live-replacement'\\n");
            `
            : `
              await fs.rm(${JSON.stringify(packagePath)});
              await fs.rm(${JSON.stringify(path.join(root, "node_modules"))}, { recursive: true });
            `}
        },
      });
      let result;
      try {
        const snapshots = (await fs.readdir(${JSON.stringify(root)}))
          .filter((entry) => entry.startsWith(".reply-regression-runtime-"));
        const snapshotPath = path.join(${JSON.stringify(root)}, snapshots[0]);
        const snapshotPackagePath = path.join(snapshotPath, "package.json");
        const snapshotDependencyLink = path.join(snapshotPath, "node_modules/fixture-dependency");
        const snapshotDependencyPath = path.join(snapshotDependencyLink, "index.js");
        result = {
          marker: loaded.RuntimeDatabase.marker,
          zodMarker: loaded.z.marker,
          snapshotCount: snapshots.length,
          snapshotMode: (await fs.stat(snapshotPath)).mode & 0o777,
          packageContents: await fs.readFile(snapshotPackagePath, "utf8"),
          packageMode: (await fs.stat(snapshotPackagePath)).mode & 0o777,
          nodeModulesMode: (await fs.stat(path.join(snapshotPath, "node_modules"))).mode & 0o777,
          dependencyLink: await fs.readlink(snapshotDependencyLink),
          dependencyContents: await fs.readFile(snapshotDependencyPath, "utf8"),
          dependencyMode: (await fs.stat(snapshotDependencyPath)).mode & 0o777,
        };
      } finally {
        await loaded.cleanup();
      }
      result.remainingSnapshots = (await fs.readdir(${JSON.stringify(root)}))
        .filter((entry) => entry.startsWith(".reply-regression-runtime-"));
      process.stdout.write(JSON.stringify(result));
    `)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      marker: "validated-dependency",
      zodMarker: "validated-zod",
      snapshotCount: 1,
      snapshotMode: 0o500,
      packageContents,
      packageMode: 0o400,
      nodeModulesMode: 0o500,
      dependencyLink: ".fixture-store/fixture-dependency",
      dependencyContents: "export const marker = 'validated-dependency'\n",
      dependencyMode: 0o400,
      remainingSnapshots: [],
    })
    await expect(readFile(sentinelPath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(databaseModulePath, "utf8")).toContain("unbound-database")
    if (packageMutation === "replace") {
      expect(await readFile(packagePath, "utf8")).toContain('"type":"commonjs"')
      expect(await readFile(dependencyPath, "utf8")).toContain("live-replacement")
    } else {
      await expect(readFile(packagePath)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(stat(path.join(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" })
    }
    expect((await readdir(root)).filter((entry) => entry.startsWith(".reply-regression-runtime-"))).toEqual([])
  })

  it.each(invalidDependencyNodes)("依赖快照拒绝 %s 且不泄漏临时目录", async (invalidNode) => {
    const { root } = await createRuntimeSnapshotFixture()
    const nodeModulesPath = path.join(root, "node_modules")
    if (invalidNode === "external_symlink") {
      const externalDirectory = await mkdtemp(path.join(tmpdir(), "reply-regression-external-dependency-"))
      temporaryDirectories.push(externalDirectory)
      await symlink(
        path.relative(nodeModulesPath, externalDirectory),
        path.join(nodeModulesPath, "external-dependency"),
      )
    } else if (invalidNode === "dangling_symlink") {
      await symlink(".fixture-store/missing-dependency", path.join(nodeModulesPath, "missing-dependency"))
    } else if (invalidNode === "oversized_file") {
      const oversizedPath = path.join(nodeModulesPath, "oversized-dependency")
      await writeFile(oversizedPath, "")
      await truncate(oversizedPath, 512 * 1024 * 1024 + 1)
    } else {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("mkfifo", [path.join(nodeModulesPath, "special-node")], {
          shell: false,
          stdio: "ignore",
        })
        child.once("error", reject)
        child.once("close", (status) => status === 0 ? resolve() : reject(new Error(`mkfifo exited ${status}`)))
      })
    }

    const result = await evaluateModule(`
      try {
        const loaded = await regression.loadRegressionRuntimeModules({ rootDirectory: ${JSON.stringify(root)} });
        try {
          process.stdout.write("allowed");
        } finally {
          await loaded.cleanup();
        }
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : "unknown");
      }
    `)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("回归运行产物与当前源码或版本不一致，请先重新构建")
    expect((await readdir(root)).filter((entry) => entry.startsWith(".reply-regression-runtime-"))).toEqual([])
  })

  it.each(["dependency", "root"] as const)("依赖树首遍捕获后替换 %s 必须拒绝混合快照", async (mutation) => {
    const { root, dependencyPath } = await createRuntimeSnapshotFixture()
    const nodeModulesPath = path.join(root, "node_modules")
    const replacedNodeModulesPath = path.join(root, "node_modules-before-replacement")
    const result = await evaluateModule(`
      const fs = await import("node:fs/promises");
      try {
        const loaded = await regression.loadRegressionRuntimeModules({
          rootDirectory: ${JSON.stringify(root)},
          afterRuntimeDependencyCapture: async () => {
            ${mutation === "dependency"
              ? `await fs.writeFile(${JSON.stringify(dependencyPath)}, "export const marker = 'mid-capture-replacement'\\n");`
              : `
                await fs.rename(${JSON.stringify(nodeModulesPath)}, ${JSON.stringify(replacedNodeModulesPath)});
                await fs.mkdir(${JSON.stringify(nodeModulesPath)});
              `}
          },
        });
        try {
          process.stdout.write("allowed");
        } finally {
          await loaded.cleanup();
        }
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : "unknown");
      }
    `)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("回归运行产物与当前源码或版本不一致，请先重新构建")
    if (mutation === "dependency") {
      expect(await readFile(dependencyPath, "utf8")).toContain("mid-capture-replacement")
    } else {
      await expect(stat(replacedNodeModulesPath)).resolves.toBeDefined()
    }
    expect((await readdir(root)).filter((entry) => entry.startsWith(".reply-regression-runtime-"))).toEqual([])
  })

  it("重复 CLI focus 和旧环境变量都从完整已完成集合按请求顺序直接命中稀有样本", async () => {
    const supportRareId = "support-rare-original-id"
    const adminRareId = "admin-rare-original-id"
    const supportFocus = caseId("support", supportRareId)
    const adminFocus = caseId("admin", adminRareId)
    const result = await evaluateModule(`
      const parsed = regression.parseRegressionArguments([
        "source.sqlite", "master.key", "runtime", "report.json", "1",
        "--focus-case-id", ${JSON.stringify(supportFocus)},
        "--focus-case-id", ${JSON.stringify(supportFocus)}
      ], { REGRESSION_CASE_ID: ${JSON.stringify(adminFocus)} });
      const selected = regression.selectFocusedRegressionRows(
        [
          { source: "support", id: "support-common-newest" },
          { source: "support", id: ${JSON.stringify(supportRareId)} }
        ],
        [
          { source: "admin", id: "admin-common-newest" },
          { source: "admin", id: ${JSON.stringify(adminRareId)} }
        ],
        parsed.focusCaseIds,
      );
      process.stdout.write(JSON.stringify({
        maximumSamples: parsed.maximumSamples,
        focusCaseIds: parsed.focusCaseIds,
        selected: selected.map((row) => row.source + ":" + row.id),
      }));
    `)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      maximumSamples: 1,
      focusCaseIds: [supportFocus, adminFocus],
      selected: [`support:${supportRareId}`, `admin:${adminRareId}`],
    })
  })

  it("未知 focus case 明确失败且只回显脱敏 hash", async () => {
    const unknown = "ffffffffffff"
    const result = await evaluateModule(`
      try {
        regression.selectFocusedRegressionRows(
          [{ source: "support", id: "private-support-id" }],
          [{ source: "admin", id: "private-admin-id" }],
          [${JSON.stringify(unknown)}],
        );
      } catch (error) {
        process.stderr.write(error instanceof Error ? error.message : "unknown");
        process.exitCode = 23;
      }
    `)

    expect(result.status).toBe(23)
    expect(result.stderr).toBe(`未找到已完成回归样本：${unknown}`)
    expect(result.stderr).not.toContain("private-support-id")
    expect(result.stderr).not.toContain("private-admin-id")
  })

  it("成功与带 audit 的失败只报告可审计 gate/review 结果，不用不可证计数声称安全", async () => {
    const rawTokens = [
      "private-row-id-8899",
      "原始问题正文-不要落报告",
      "历史回复正文-不要落报告",
      "附件提取内容-不要落报告",
      "merchantOrder=ORDER-PRIVATE-8899",
      "password=credential-secret",
    ]
    const result = await evaluateModule(`
      const audit = {
        version: "evidence-binding-review-v2",
        mode: "multi_stage",
        evidencePacket: {
          version: "2",
          facts: [
            { id: "F1", outboundSafe: true, statement: ${JSON.stringify(rawTokens[4])} },
            { id: "F2", outboundSafe: false, statement: ${JSON.stringify(rawTokens[5])} }
          ],
          associations: [
            { id: "A1", status: "unconfirmed", matchedIdentifiers: [{ value: "ORDER-PRIVATE-8899" }] },
            { id: "A2", status: "conflicting", conflicts: [{ summary: ${JSON.stringify(rawTokens[3])} }] },
            { id: "A3", status: "unconfirmed" }
          ]
        },
        baselineAnswer: ${JSON.stringify(rawTokens[2])},
        firstCandidateAnswer: null,
        revisedCandidateAnswer: ${JSON.stringify(rawTokens[1])},
        reviews: [
          { stage: "gate", attempt: 0, outcome: "issues", issues: [${JSON.stringify(rawTokens[3])}], reason: "gate" },
          { stage: "revision_review", attempt: 2, outcome: "approve", issues: [], reason: "approved" }
        ],
        finalSource: "revised_candidate",
        fallbackReason: null
      };
      const row = {
        id: ${JSON.stringify(rawTokens[0])}, source: "support", corrected: 0, has_attachment: 1,
        status: "replied", question: ${JSON.stringify(rawTokens[1])}, answer: ${JSON.stringify(rawTokens[2])},
        attachmentContent: ${JSON.stringify(rawTokens[3])}
      };
      const comparison = {
        preferred: "new", regression: false,
        dimensions: { factualGrounding: 1, completeness: 0, requestFit: 1, recipientClarity: 0, evidenceUse: 1, safetyBoundary: 1 },
        issues: [${JSON.stringify(rawTokens[3])}], reason: ${JSON.stringify(rawTokens[5])}
      };
      const success = regression.buildSuccessfulRegressionCase({
        row, caseId: "0123456789ab",
        result: { pipelineAudit: audit, decision: { decision: "reply", answer: ${JSON.stringify(rawTokens[1])}, answerClaims: [{ factId: "F1" }, { factId: "F2" }] } },
        comparison, durationMs: 15,
      });
      const blockedAudit = {
        ...audit,
        reviews: [...audit.reviews, { stage: "blocked", attempt: 0, outcome: "blocked", issues: [${JSON.stringify(rawTokens[1])}], reason: "blocked" }],
        finalSource: "baseline",
        fallbackReason: ${JSON.stringify(rawTokens[5])}
      };
      const failure = new Error(${JSON.stringify(rawTokens.join(" | "))});
      failure.name = "SupportModelOutputRejectedError";
      failure.pipelineAudit = blockedAudit;
      const failed = regression.buildFailedRegressionCase({ row, caseId: "abcdef012345", error: failure, durationMs: 9 });
      const summary = regression.summarizeRegressionCases([success, failed]);
      process.stdout.write(JSON.stringify({ success, failed, summary }));
    `)

    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout) as {
      success: Record<string, unknown>
      failed: Record<string, unknown>
      summary: Record<string, unknown>
    }
    expect(output.success).toMatchObject({
      evidencePacketVersion: "2",
      associationStatuses: ["conflicting", "unconfirmed"],
      gateOutcome: "issues",
      strictReviewOutcome: "approve",
      blockedNotSent: false,
      comparison: {
        preferred: "new",
        regression: false,
        issueCount: 1,
      },
    })
    expect(output.failed).toMatchObject({
      error: "SupportModelOutputRejectedError",
      evidencePacketVersion: "2",
      associationStatuses: ["conflicting", "unconfirmed"],
      gateOutcome: "issues",
      strictReviewOutcome: "blocked",
      blockedNotSent: true,
    })
    expect(output.success).not.toHaveProperty("unsafeClaimCount")
    expect(output.failed).not.toHaveProperty("unsafeClaimCount")
    expect(output.failed).not.toHaveProperty("errorMessage")
    expect(JSON.stringify(output).match(/"preferredNew"/gu)).toHaveLength(1)
    expect(output.summary).toMatchObject({
      completed: 1,
      failed: 1,
      preferredNew: 1,
      approvedBaseline: 0,
      blockedNotSent: 1,
    })
    expect(output.summary).not.toHaveProperty("baselineFallbacks")
    for (const token of rawTokens) expect(result.stdout).not.toContain(token)
  })

  it("v1 证据包、缺 gate 或非 ignore 缺少 reviewer approve 都按 case failed 关门", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reply-regression-audit-contract-"))
    temporaryDirectories.push(directory)
    const reports = ["v1.json", "missing-gate.json", "missing-approval.json"].map((name) => path.join(directory, name))
    const result = await evaluateModule(`
      const reports = ${JSON.stringify(reports)};
      const comparison = {
        preferred: "new", regression: false,
        dimensions: { factualGrounding: 0, completeness: 0, requestFit: 0, recipientClarity: 0, evidenceUse: 0, safetyBoundary: 0 },
        issues: [], reason: "same"
      };
      const validAudit = {
        version: "evidence-binding-review-v2", mode: "multi_stage",
        evidencePacket: { version: "2", associations: [] },
        baselineAnswer: "candidate", firstCandidateAnswer: null, revisedCandidateAnswer: null,
        reviews: [
          { stage: "gate", attempt: 0, outcome: "pass", issues: [], reason: "gate" },
          { stage: "baseline_review", attempt: 1, outcome: "approve", issues: [], reason: "approved" }
        ],
        finalSource: "baseline", fallbackReason: null,
      };
      const invalidAudits = [
        { ...validAudit, evidencePacket: { version: "1", associations: [] } },
        { ...validAudit, reviews: validAudit.reviews.filter((review) => review.stage !== "gate") },
        { ...validAudit, reviews: [
          validAudit.reviews[0],
          { stage: "baseline_review", attempt: 1, outcome: "revise", issues: ["missing"], reason: "revise" }
        ] },
      ];
      const row = { source: "support", corrected: 0, has_attachment: 0, status: "replied" };
      const outcomes = [];
      for (let index = 0; index < invalidAudits.length; index += 1) {
        let caseResult;
        try {
          caseResult = regression.buildSuccessfulRegressionCase({
            row, caseId: String(index).padStart(12, "0"),
            result: { pipelineAudit: invalidAudits[index], decision: { decision: "reply", answer: "candidate" } },
            comparison, durationMs: 1,
          });
        } catch (error) {
          caseResult = regression.buildFailedRegressionCase({
            row, caseId: String(index).padStart(12, "0"), error, durationMs: 1,
          });
        }
        const summary = regression.summarizeRegressionCases([caseResult]);
        let gateError = null;
        try {
          await regression.finalizeRegressionReport({ cases: [caseResult], summary }, reports[index], 1);
        } catch (error) {
          gateError = error instanceof Error ? error.message : "unknown";
        }
        outcomes.push({ caseResult, summary, gateError });
      }
      const ignore = regression.buildSuccessfulRegressionCase({
        row, caseId: "ffffffffffff",
        result: {
          pipelineAudit: {
            ...validAudit, mode: "legacy",
            baselineAnswer: "",
            reviews: [validAudit.reviews[0]],
            fallbackReason: "ignore 不生成对外回复",
          },
          decision: { decision: "ignore", answer: "" },
        },
        comparison, durationMs: 1,
      });
      process.stdout.write(JSON.stringify({ outcomes, ignore }));
    `)

    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout) as {
      outcomes: Array<{
        caseResult: { error?: string }
        summary: { completed: number; failed: number; regressions: number }
        gateError: string | null
      }>
      ignore: { error?: string; gateOutcome: string; strictReviewOutcome: null }
    }
    expect(output.outcomes).toHaveLength(3)
    for (const outcome of output.outcomes) {
      expect(outcome.caseResult.error).toBe("RegressionAuditRejectedError")
      expect(outcome.summary).toMatchObject({ completed: 0, failed: 1, regressions: 0 })
      expect(outcome.gateError).toBe("回归发布门禁未通过：存在执行失败")
    }
    expect(output.ignore).toMatchObject({ gateOutcome: "pass", strictReviewOutcome: null })
    expect(output.ignore.error).toBeUndefined()
    for (const reportPath of reports) expect((await stat(reportPath)).mode & 0o777).toBe(0o600)
  })

  it("真实 pipeline 的 ignore gate issues 可通过，畸形 attempt、issues 和 fallback 状态必须拒绝", async () => {
    const realIgnore = await realIgnorePipelineFixture()
    expect(realIgnore.pipelineAudit.reviews).toEqual([
      expect.objectContaining({ stage: "gate", attempt: 0, outcome: "issues" }),
    ])
    expect(realIgnore.pipelineAudit.reviews[0]?.issues.length).toBeGreaterThan(12)
    const result = await evaluateModule(`
      const comparison = {
        preferred: "new", regression: false,
        dimensions: { factualGrounding: 0, completeness: 0, requestFit: 0, recipientClarity: 0, evidenceUse: 0, safetyBoundary: 0 },
        issues: [], reason: "same"
      };
      const row = { source: "support", corrected: 0, has_attachment: 0, status: "replied" };
      const check = (pipelineAudit, decision) => {
        try {
          regression.buildSuccessfulRegressionCase({
            row, caseId: "0123456789ab", result: { pipelineAudit, decision }, comparison, durationMs: 1,
          });
          return "ok";
        } catch (error) {
          return error instanceof Error ? error.name : "unknown";
        }
      };
      const realIgnore = ${JSON.stringify(realIgnore)};
      const gatePass = { stage: "gate", attempt: 0, outcome: "pass", issues: [], reason: "交易证据门禁通过" };
      const baselineApprove = {
        stage: "baseline_review", attempt: 1, outcome: "approve", issues: [], reason: "基线通过独立审核",
      };
      const validBaseline = {
        version: "evidence-binding-review-v2", mode: "multi_stage",
        evidencePacket: { version: "2", associations: [] },
        baselineAnswer: "baseline", firstCandidateAnswer: null, revisedCandidateAnswer: null,
        reviews: [gatePass, baselineApprove], finalSource: "baseline", fallbackReason: null,
      };
      const gateIssues = {
        stage: "gate", attempt: 0, outcome: "issues", issues: ["需要收窄"], reason: "交易证据门禁要求收窄或改写回复",
      };
      const revisionApprove = {
        stage: "revision_review", attempt: 2, outcome: "approve", issues: [], reason: "修订稿通过独立审核",
      };
      const validRevision = {
        ...validBaseline,
        baselineAnswer: "baseline", revisedCandidateAnswer: "revised",
        reviews: [gateIssues, revisionApprove], finalSource: "revised_candidate",
      };
      const invalid = [
        { audit: { ...validBaseline, reviews: [{ ...gatePass, attempt: 1 }, baselineApprove] }, answer: "baseline" },
        { audit: { ...validBaseline, reviews: [gatePass, { ...baselineApprove, attempt: 0 }] }, answer: "baseline" },
        { audit: { ...validBaseline, reviews: [gatePass, { ...baselineApprove, issues: ["仍有问题"] }] }, answer: "baseline" },
        { audit: { ...validBaseline, reviews: [{ ...gatePass, issues: ["pass 不得带 issues"] }, baselineApprove] }, answer: "baseline" },
        { audit: { ...validBaseline, reviews: [gatePass, { ...baselineApprove, issues: null }] }, answer: "baseline" },
        { audit: { ...validBaseline, fallbackReason: "blocked_not_sent: impossible success" }, answer: "baseline" },
        { audit: { ...validBaseline, firstCandidateAnswer: "never-produced" }, answer: "baseline" },
        { audit: { ...validRevision, reviews: [gateIssues, { ...revisionApprove, attempt: 0 }] }, answer: "revised" },
        { audit: { ...validRevision, reviews: [gateIssues, { ...revisionApprove, issues: ["仍有问题"] }] }, answer: "revised" },
        { audit: { ...realIgnore.pipelineAudit, fallbackReason: null }, answer: "" },
      ];
      process.stdout.write(JSON.stringify({
        realIgnore: check(realIgnore.pipelineAudit, realIgnore.decision),
        invalid: invalid.map((scenario) => check(
          scenario.audit,
          { decision: scenario.answer ? "reply" : "ignore", answer: scenario.answer },
        )),
      }));
    `)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      realIgnore: "ok",
      invalid: Array.from({ length: 10 }, () => "RegressionAuditRejectedError"),
    })
  })

  it("审计状态机绑定最终获批稿，拒绝 gate issues 基线、正文偏离和 blocked 结果", async () => {
    const result = await evaluateModule(`
      const comparison = {
        preferred: "new", regression: false,
        dimensions: { factualGrounding: 0, completeness: 0, requestFit: 0, recipientClarity: 0, evidenceUse: 0, safetyBoundary: 0 },
        issues: [], reason: "same"
      };
      const gatePass = { stage: "gate", attempt: 0, outcome: "pass", issues: [], reason: "gate" };
      const gateIssues = { stage: "gate", attempt: 0, outcome: "issues", issues: ["binding"], reason: "gate" };
      const baselineApprove = { stage: "baseline_review", attempt: 1, outcome: "approve", issues: [], reason: "approved" };
      const revisionApprove = { stage: "revision_review", attempt: 2, outcome: "approve", issues: [], reason: "approved" };
      const blocked = { stage: "blocked", attempt: 0, outcome: "blocked", issues: ["blocked"], reason: "blocked" };
      const base = {
        version: "evidence-binding-review-v2", mode: "multi_stage",
        evidencePacket: { version: "2", associations: [] },
        baselineAnswer: "baseline", firstCandidateAnswer: null, revisedCandidateAnswer: "revised",
        fallbackReason: null,
      };
      const scenarios = [
        {
          audit: { ...base, finalSource: "revised_candidate", reviews: [gatePass, baselineApprove] },
          answer: "revised",
        },
        {
          audit: { ...base, finalSource: "baseline", reviews: [gateIssues, baselineApprove] },
          answer: "baseline",
        },
        {
          audit: { ...base, finalSource: "revised_candidate", reviews: [gateIssues, revisionApprove] },
          answer: "answer-not-approved",
        },
        {
          audit: { ...base, finalSource: "baseline", reviews: [gatePass, baselineApprove] },
          answer: "answer-not-approved",
        },
        {
          audit: { ...base, finalSource: "baseline", reviews: [gatePass, baselineApprove, blocked] },
          answer: "baseline",
        },
      ];
      const row = { source: "support", corrected: 0, has_attachment: 0, status: "replied" };
      const errors = scenarios.map((scenario, index) => {
        try {
          regression.buildSuccessfulRegressionCase({
            row, caseId: String(index).padStart(12, "0"),
            result: {
              pipelineAudit: scenario.audit,
              decision: { decision: "reply", answer: scenario.answer },
            },
            comparison, durationMs: 1,
          });
          return null;
        } catch (error) {
          return error instanceof Error ? error.name : "unknown";
        }
      });
      process.stdout.write(JSON.stringify(errors));
    `)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      "RegressionAuditRejectedError",
      "RegressionAuditRejectedError",
      "RegressionAuditRejectedError",
      "RegressionAuditRejectedError",
      "RegressionAuditRejectedError",
    ])
  })

  it("畸形错误审计中的任意字符串不会进入回归报告", async () => {
    const privateValue = "merchant-private-value-should-never-be-reported"
    const result = await evaluateModule(`
      const error = new Error("hidden message");
      error.name = ${JSON.stringify(privateValue)};
      error.pipelineAudit = {
        version: "evidence-binding-review-v2",
        mode: ${JSON.stringify(privateValue)},
        finalSource: ${JSON.stringify(privateValue)},
        evidencePacket: {
          version: ${JSON.stringify(privateValue)},
          facts: [],
          associations: [{ status: ${JSON.stringify(privateValue)} }]
        },
        reviews: [{ stage: "blocked", outcome: ${JSON.stringify(privateValue)} }]
      };
      const value = regression.buildFailedRegressionCase({
        row: { source: "support", corrected: 0, has_attachment: 0, status: "failed" },
        caseId: "0123456789ab", error, durationMs: 1,
      });
      process.stdout.write(JSON.stringify(value));
    `)

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain(privateValue)
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: "UnknownError",
      evidencePacketVersion: null,
      associationStatuses: [],
      strictReviewOutcome: null,
    })
  })

  it("数据库入口强制只读打开且不会改写输入副本", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reply-regression-readonly-"))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, "source.sqlite")
    const sentinel = "immutable-source-database-sentinel"
    await writeFile(databasePath, sentinel)
    const result = await evaluateModule(`
      const { readFileSync, writeFileSync } = await import("node:fs");
      const calls = [];
      class FakeRuntimeDatabase {
        static async open(filePath) {
          writeFileSync(filePath, "mutated-by-writable-open");
          return {};
        }
        static openPortable(filePath, readOnly) {
          calls.push({ filePath, readOnly });
          if (!readOnly) writeFileSync(filePath, "mutated-by-portable-open");
          readFileSync(filePath);
          return { close() {} };
        }
      }
      regression.openRegressionDatabase(FakeRuntimeDatabase, ${JSON.stringify(databasePath)});
      process.stdout.write(JSON.stringify({ calls, contents: readFileSync(${JSON.stringify(databasePath)}, "utf8") }));
    `)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      calls: [{ filePath: databasePath, readOnly: true }],
      contents: sentinel,
    })
    expect(await readFile(databasePath, "utf8")).toBe(sentinel)
  })

  it("报告在任何写入前拒绝数据库、密钥及已有 sidecar 的 exact、symlink 和 hardlink 同 inode", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reply-regression-output-isolation-"))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, "source.sqlite")
    const masterKeyPath = path.join(directory, "master.key")
    const walPath = `${databasePath}-wal`
    const shmPath = `${databasePath}-shm`
    const keySymlink = path.join(directory, "key-report-link.json")
    const databaseHardlink = path.join(directory, "database-report-hardlink.json")
    const danglingDatabasePath = path.join(directory, "future.sqlite")
    const danglingSidecarPath = `${danglingDatabasePath}-wal`
    const danglingSidecarReport = path.join(directory, "dangling-sidecar-report.json")
    await writeFile(databasePath, "immutable-database-bytes")
    await writeFile(masterKeyPath, Buffer.alloc(32, 7))
    await writeFile(walPath, "immutable-wal-bytes")
    await writeFile(shmPath, "immutable-shm-bytes")
    await writeFile(danglingDatabasePath, "immutable-future-database")
    await chmod(databasePath, 0o640)
    await chmod(masterKeyPath, 0o600)
    await chmod(walPath, 0o644)
    await chmod(shmPath, 0o604)
    await symlink(masterKeyPath, keySymlink)
    await link(databasePath, databaseHardlink)
    await symlink(danglingSidecarPath, danglingSidecarReport)
    const protectedPaths = [databasePath, masterKeyPath, walPath, shmPath]
    const before = await Promise.all(protectedPaths.map(async (filePath) => ({
      filePath,
      contents: await readFile(filePath),
      mode: (await stat(filePath)).mode & 0o777,
    })))
    const collisionPaths = [databasePath, keySymlink, databaseHardlink, walPath, shmPath]
    const report = { cases: [], summary: { completed: 1, failed: 0, regressions: 0 } }
    const result = await evaluateModule(`
      const collisions = [];
      for (const reportPath of ${JSON.stringify(collisionPaths)}) {
        try {
          await regression.assertRegressionOutputIsolation({
            databasePath: ${JSON.stringify(databasePath)},
            masterKeyPath: ${JSON.stringify(masterKeyPath)},
            reportPath,
          });
        } catch (error) {
          collisions.push(error instanceof Error ? error.message : "unknown");
        }
      }
      let finalizeError = null;
      try {
        await regression.finalizeRegressionReport(
          ${JSON.stringify(report)},
          ${JSON.stringify(databasePath)},
          1,
          { databasePath: ${JSON.stringify(databasePath)}, masterKeyPath: ${JSON.stringify(masterKeyPath)} },
        );
      } catch (error) {
        finalizeError = error instanceof Error ? error.message : "unknown";
      }
      let danglingSidecarError = null;
      try {
        await regression.assertRegressionOutputIsolation({
          databasePath: ${JSON.stringify(danglingDatabasePath)},
          masterKeyPath: ${JSON.stringify(masterKeyPath)},
          reportPath: ${JSON.stringify(danglingSidecarReport)},
        });
      } catch (error) {
        danglingSidecarError = error instanceof Error ? error.message : "unknown";
      }
      process.stdout.write(JSON.stringify({ collisions, finalizeError, danglingSidecarError }));
    `)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      collisions: Array.from({ length: collisionPaths.length }, () => "回归报告路径与只读输入文件冲突"),
      finalizeError: "回归报告路径与只读输入文件冲突",
      danglingSidecarError: "回归报告路径与只读输入文件冲突",
    })
    for (const snapshot of before) {
      expect(await readFile(snapshot.filePath)).toEqual(snapshot.contents)
      expect((await stat(snapshot.filePath)).mode & 0o777).toBe(snapshot.mode)
    }
    await expect(stat(danglingSidecarPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("报告路径不得覆盖 runtime canonical subtree 的现有、不存在、父目录、symlink 或 hardlink 路径", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reply-regression-runtime-isolation-"))
    temporaryDirectories.push(directory)
    const runtimeDirectory = path.join(directory, "runtime")
    const safeDirectory = path.join(directory, "safe")
    const externalDirectory = path.join(directory, "external-runtime-source")
    await mkdir(path.join(runtimeDirectory, "nested"), { recursive: true })
    await mkdir(safeDirectory, { recursive: true })
    await mkdir(externalDirectory, { recursive: true })
    const databasePath = path.join(directory, "source.sqlite")
    const masterKeyPath = path.join(directory, "master.key")
    const runtimeFile = path.join(runtimeDirectory, "nested", "runtime-state.json")
    const missingRuntimeReport = path.join(runtimeDirectory, "nested", "future-report.json")
    const runtimeDirectoryAlias = path.join(directory, "runtime-alias")
    const reportThroughParentSymlink = path.join(runtimeDirectoryAlias, "nested", "alias-report.json")
    const runtimeFileSymlink = path.join(safeDirectory, "runtime-file-symlink.json")
    const runtimeFileHardlink = path.join(safeDirectory, "runtime-file-hardlink.json")
    const runtimeExternalDirectoryLink = path.join(runtimeDirectory, "external-reference")
    const externalRuntimeSource = path.join(externalDirectory, "source.json")
    const safeReport = path.join(safeDirectory, "safe-report.json")
    const replaceableHardlinkReport = path.join(safeDirectory, "replaceable-hardlink-report.json")
    const unrelatedHardlinkSource = path.join(safeDirectory, "unrelated-hardlink-source.json")
    await writeFile(databasePath, "immutable-database")
    await writeFile(masterKeyPath, Buffer.alloc(32, 5))
    await writeFile(runtimeFile, "immutable-runtime-state")
    await chmod(runtimeFile, 0o640)
    await writeFile(externalRuntimeSource, "immutable-external-runtime-source")
    await chmod(externalRuntimeSource, 0o604)
    await writeFile(unrelatedHardlinkSource, "unrelated-hardlink-source")
    await chmod(unrelatedHardlinkSource, 0o640)
    await symlink(runtimeDirectory, runtimeDirectoryAlias)
    await symlink(runtimeFile, runtimeFileSymlink)
    await symlink(externalDirectory, runtimeExternalDirectoryLink)
    await link(runtimeFile, runtimeFileHardlink)
    await link(unrelatedHardlinkSource, replaceableHardlinkReport)
    const beforeContents = await readFile(runtimeFile)
    const beforeMode = (await stat(runtimeFile)).mode & 0o777
    const externalBeforeContents = await readFile(externalRuntimeSource)
    const externalBeforeMode = (await stat(externalRuntimeSource)).mode & 0o777
    const unrelatedBeforeInode = (await stat(unrelatedHardlinkSource)).ino
    const collisionPaths = [
      runtimeDirectory,
      runtimeFile,
      missingRuntimeReport,
      reportThroughParentSymlink,
      runtimeFileSymlink,
      runtimeFileHardlink,
      externalRuntimeSource,
      directory,
    ]
    const report = { cases: [], summary: { completed: 1, failed: 0, regressions: 0 } }
    const result = await evaluateModule(`
      const collisions = [];
      for (const reportPath of ${JSON.stringify(collisionPaths)}) {
        try {
          await regression.assertRegressionOutputIsolation({
            databasePath: ${JSON.stringify(databasePath)},
            masterKeyPath: ${JSON.stringify(masterKeyPath)},
            runtimeDirectory: ${JSON.stringify(runtimeDirectory)},
            reportPath,
          });
          collisions.push("allowed");
        } catch (error) {
          collisions.push(error instanceof Error ? error.message : "unknown");
        }
      }
      const finalizeErrors = [];
      try {
        await regression.finalizeRegressionReport(
          ${JSON.stringify(report)}, ${JSON.stringify(runtimeFile)}, 1,
          {
            databasePath: ${JSON.stringify(databasePath)},
            masterKeyPath: ${JSON.stringify(masterKeyPath)},
            runtimeDirectory: ${JSON.stringify(runtimeDirectory)},
          },
        );
      } catch (error) {
        finalizeErrors.push(error instanceof Error ? error.message : "unknown");
      }
      try {
        await regression.finalizeRegressionReport(
          ${JSON.stringify(report)}, ${JSON.stringify(externalRuntimeSource)}, 1,
          {
            databasePath: ${JSON.stringify(databasePath)},
            masterKeyPath: ${JSON.stringify(masterKeyPath)},
            runtimeDirectory: ${JSON.stringify(runtimeDirectory)},
          },
        );
      } catch (error) {
        finalizeErrors.push(error instanceof Error ? error.message : "unknown");
      }
      await regression.finalizeRegressionReport(
        ${JSON.stringify(report)}, ${JSON.stringify(safeReport)}, 1,
        {
          databasePath: ${JSON.stringify(databasePath)},
          masterKeyPath: ${JSON.stringify(masterKeyPath)},
          runtimeDirectory: ${JSON.stringify(runtimeDirectory)},
        },
      );
      await regression.finalizeRegressionReport(
        ${JSON.stringify(report)}, ${JSON.stringify(replaceableHardlinkReport)}, 1,
        {
          databasePath: ${JSON.stringify(databasePath)},
          masterKeyPath: ${JSON.stringify(masterKeyPath)},
          runtimeDirectory: ${JSON.stringify(runtimeDirectory)},
        },
      );
      process.stdout.write(JSON.stringify({ collisions, finalizeErrors }));
    `)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      collisions: Array.from({ length: collisionPaths.length }, () => "回归报告路径与只读输入文件冲突"),
      finalizeErrors: [
        "回归报告路径与只读输入文件冲突",
        "回归报告路径与只读输入文件冲突",
      ],
    })
    expect(await readFile(runtimeFile)).toEqual(beforeContents)
    expect((await stat(runtimeFile)).mode & 0o777).toBe(beforeMode)
    expect(await readFile(externalRuntimeSource)).toEqual(externalBeforeContents)
    expect((await stat(externalRuntimeSource)).mode & 0o777).toBe(externalBeforeMode)
    await expect(stat(missingRuntimeReport)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await stat(safeReport)).mode & 0o777).toBe(0o600)
    expect(await readFile(unrelatedHardlinkSource, "utf8")).toBe("unrelated-hardlink-source")
    expect((await stat(unrelatedHardlinkSource)).mode & 0o777).toBe(0o640)
    expect((await stat(unrelatedHardlinkSource)).ino).toBe(unrelatedBeforeInode)
    expect((await stat(replaceableHardlinkReport)).ino).not.toBe(unrelatedBeforeInode)
    expect((await stat(replaceableHardlinkReport)).mode & 0o777).toBe(0o600)
    expect(await readFile(replaceableHardlinkReport, "utf8")).toContain('"completed": 1')
  })

  it("runtime 符号链接环和超深引用都快速 fail-closed，不无界扫描外部目录", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reply-regression-runtime-bounds-"))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, "source.sqlite")
    const masterKeyPath = path.join(directory, "master.key")
    const cycleRuntime = path.join(directory, "cycle-runtime")
    const deepRuntime = path.join(directory, "deep-runtime")
    const deepLinks = path.join(directory, "deep-links")
    const externalTarget = path.join(directory, "external-target")
    await mkdir(cycleRuntime)
    await mkdir(deepRuntime)
    await mkdir(deepLinks)
    await mkdir(externalTarget)
    await writeFile(databasePath, "immutable-database")
    await writeFile(masterKeyPath, Buffer.alloc(32, 6))
    await symlink(path.join(cycleRuntime, "second"), path.join(cycleRuntime, "first"))
    await symlink(path.join(cycleRuntime, "first"), path.join(cycleRuntime, "second"))
    let nextTarget = externalTarget
    for (let index = 11; index >= 0; index -= 1) {
      const linkPath = path.join(deepLinks, `link-${index}`)
      await symlink(nextTarget, linkPath)
      nextTarget = linkPath
    }
    await symlink(nextTarget, path.join(deepRuntime, "external-reference"))
    const reports = [path.join(directory, "cycle-report.json"), path.join(directory, "deep-report.json")]
    const result = await evaluateModule(`
      const runtimes = ${JSON.stringify([cycleRuntime, deepRuntime])};
      const reports = ${JSON.stringify(reports)};
      const outcomes = [];
      for (let index = 0; index < runtimes.length; index += 1) {
        try {
          await regression.assertRegressionOutputIsolation({
            databasePath: ${JSON.stringify(databasePath)},
            masterKeyPath: ${JSON.stringify(masterKeyPath)},
            runtimeDirectory: runtimes[index],
            reportPath: reports[index],
          });
          outcomes.push("allowed");
        } catch (error) {
          outcomes.push(error instanceof Error ? error.message : "unknown");
        }
      }
      process.stdout.write(JSON.stringify(outcomes));
    `)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      "无法校验回归报告路径隔离",
      "无法校验回归报告路径隔离",
    ])
    for (const reportPath of reports) await expect(stat(reportPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("宿主把 evaluator 六维任一退步或历史偏好矛盾判为 case failed，并在 0600 报告后非零关门", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reply-regression-comparison-gate-"))
    temporaryDirectories.push(directory)
    const reports = [
      "factual.json", "completeness.json", "request-fit.json", "recipient-clarity.json",
      "evidence-use.json", "safety.json", "historical.json",
    ].map((name) => path.join(directory, name))
    const comparisons = [
      {
        preferred: "tie", regression: false,
        dimensions: { factualGrounding: -1, completeness: 0, requestFit: 0, recipientClarity: 0, evidenceUse: 0, safetyBoundary: 0 },
        issues: ["事实依据明确退步"], reason: "事实依据明确退步但错误返回 false",
      },
      {
        preferred: "tie", regression: false,
        dimensions: { factualGrounding: 0, completeness: -1, requestFit: 0, recipientClarity: 0, evidenceUse: 0, safetyBoundary: 0 },
        issues: ["完整性明确退步"], reason: "完整性明确退步但错误返回 false",
      },
      {
        preferred: "tie", regression: false,
        dimensions: { factualGrounding: 0, completeness: 0, requestFit: -1, recipientClarity: 0, evidenceUse: 0, safetyBoundary: 0 },
        issues: ["诉求匹配明确退步"], reason: "诉求匹配明确退步但错误返回 false",
      },
      {
        preferred: "tie", regression: false,
        dimensions: { factualGrounding: 0, completeness: 0, requestFit: 0, recipientClarity: -1, evidenceUse: 0, safetyBoundary: 0 },
        issues: ["接收方明确性退步"], reason: "接收方明确性退步但错误返回 false",
      },
      {
        preferred: "tie", regression: false,
        dimensions: { factualGrounding: 0, completeness: 0, requestFit: 0, recipientClarity: 0, evidenceUse: -1, safetyBoundary: 0 },
        issues: ["证据使用明确退步"], reason: "证据使用明确退步但错误返回 false",
      },
      {
        preferred: "tie", regression: false,
        dimensions: { factualGrounding: 0, completeness: 0, requestFit: 0, recipientClarity: 0, evidenceUse: 0, safetyBoundary: -1 },
        issues: ["安全边界明确退步"], reason: "安全边界明确退步但错误返回 false",
      },
      {
        preferred: "historical", regression: false,
        dimensions: { factualGrounding: 0, completeness: 0, requestFit: 0, recipientClarity: 0, evidenceUse: 0, safetyBoundary: 0 },
        issues: ["历史回复更好"], reason: "偏好历史回复但错误返回 false",
      },
    ]
    const result = await evaluateModule(`
      const reports = ${JSON.stringify(reports)};
      const comparisons = ${JSON.stringify(comparisons)};
      const audit = {
        version: "evidence-binding-review-v2", mode: "multi_stage", evidencePacket: { version: "2", associations: [] },
        baselineAnswer: "candidate", firstCandidateAnswer: null, revisedCandidateAnswer: null,
        reviews: [
          { stage: "gate", attempt: 0, outcome: "pass", issues: [], reason: "gate" },
          { stage: "baseline_review", attempt: 1, outcome: "approve", issues: [], reason: "approved" }
        ], finalSource: "baseline", fallbackReason: null,
      };
      const row = { source: "support", corrected: 0, has_attachment: 0, status: "replied" };
      const outcomes = [];
      for (let index = 0; index < comparisons.length; index += 1) {
        let caseResult;
        try {
          caseResult = regression.buildSuccessfulRegressionCase({
            row, caseId: String(index).padStart(12, "0"),
            result: { pipelineAudit: audit, decision: { decision: "reply", answer: "candidate" } },
            comparison: comparisons[index], durationMs: 1,
          });
        } catch (error) {
          caseResult = regression.buildFailedRegressionCase({
            row, caseId: String(index).padStart(12, "0"), error, durationMs: 1,
          });
        }
        const summary = regression.summarizeRegressionCases([caseResult]);
        let gateError = null;
        try {
          await regression.finalizeRegressionReport({ cases: [caseResult], summary }, reports[index], 1);
        } catch (error) {
          gateError = error instanceof Error ? error.message : "unknown";
        }
        outcomes.push({ caseResult, summary, gateError });
      }
      process.stdout.write(JSON.stringify(outcomes));
    `)

    expect(result.status).toBe(0)
    const outcomes = JSON.parse(result.stdout) as Array<{
      caseResult: { error?: string }
      summary: { completed: number; failed: number; regressions: number }
      gateError: string | null
    }>
    expect(outcomes).toHaveLength(7)
    for (const outcome of outcomes) {
      expect(outcome.caseResult.error).toBe("RegressionComparisonRejectedError")
      expect(outcome.summary).toMatchObject({ completed: 0, failed: 1, regressions: 0 })
      expect(outcome.gateError).toBe("回归发布门禁未通过：存在执行失败")
    }
    for (const reportPath of reports) expect((await stat(reportPath)).mode & 0o777).toBe(0o600)
  })

  it("主密钥副本不存在时只失败，不在指定位置生成新密钥", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reply-regression-key-"))
    temporaryDirectories.push(directory)
    const missingKeyPath = path.join(directory, "missing", "master.key")
    const result = await evaluateModule(`
      try {
        await regression.assertRegressionMasterKey(${JSON.stringify(missingKeyPath)});
      } catch (error) {
        process.stderr.write(error instanceof Error ? error.message : "unknown");
        process.exitCode = 24;
      }
    `)

    expect(result.status).toBe(24)
    expect(result.stderr).toBe("回归主密钥副本不可读取或格式错误")
    await expect(readFile(missingKeyPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("用真实 RuntimeDatabase 回放 Deva 多消息截图，只取目标回复边界并兼容纠正与旧附件", async () => {
    const databasePath = await seedReplayDatabase()
    const result = await evaluateModule(`
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(${JSON.stringify(databasePath)}, { readOnly: true });
      const rows = regression.loadSupportRegressionRows(database);
      const corrected = rows.find((row) => row.id === "deva-corrected-reply");
      const invalidIncluded = rows.some((row) => row.id === "invalid-correction-reply");
      const legacy = rows.find((row) => row.id === "legacy-reply");
      const correctedContext = regression.buildReplayRequestContext(database, corrected, {});
      const legacyContext = regression.buildReplayRequestContext(database, legacy, {});
      process.stdout.write(JSON.stringify({
        schemaVersion: regression.assertRegressionSchemaVersion(database),
        corrected: {
          answer: corrected?.answer,
          historicalWrongAnswerWasReused: corrected?.answer === "原来的错误回答不得复用",
          hasAttachment: corrected?.has_attachment,
          latestMessage: correctedContext.latestMessage,
          responseDepth: correctedContext.responseDepth,
          conversationContext: correctedContext.conversationContext,
          attachmentNames: correctedContext.attachments.map((attachment) => attachment.name),
          extractedTexts: correctedContext.attachments.map((attachment) => attachment.extractedText),
          replyStyle: correctedContext.replyStyle,
          includeAiMemory: correctedContext.includeAiMemory,
          includeInterfaceDocs: correctedContext.includeInterfaceDocs,
          includeMagicBook: correctedContext.includeMagicBook,
          pinnedStyleMaxChars: correctedContext.operatorStyleProfile.shortSentenceMaxChars,
        },
        invalidIncluded,
        legacy: {
          hasAttachment: legacy?.has_attachment,
          attachmentNames: legacyContext.attachments.map((attachment) => attachment.name),
          latestMessage: legacyContext.latestMessage,
        },
      }));
      database.close();
    `)

    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.schemaVersion).toBe(34)
    expect(output.corrected).toMatchObject({
      answer: "最新人工正确回答\n第二行也属于回答",
      historicalWrongAnswerWasReused: false,
      hasAttachment: 1,
      latestMessage: "截图补充如下",
      responseDepth: "followup",
      attachmentNames: ["deva-shot.png"],
      extractedTexts: ["截图显示上游已成功"],
      replyStyle: "unrestricted",
      includeAiMemory: false,
      includeInterfaceDocs: true,
      includeMagicBook: false,
      pinnedStyleMaxChars: 41,
    })
    expect(output.corrected.conversationContext).toContain("先前已回复的上下文")
    expect(output.corrected.conversationContext).not.toContain("发送跨过目标时点不应出现")
    expect(output.corrected.conversationContext).toContain("截图补充如下")
    expect(output.corrected.conversationContext).not.toContain("目标回复发送后的补充")
    expect(output.corrected.attachmentNames).not.toContain("later-shot.png")
    expect(output.invalidIncluded).toBe(false)
    expect(output.legacy).toEqual({
      hasAttachment: 1,
      attachmentNames: ["legacy.txt"],
      latestMessage: "旧版附件问题",
    })
  })

  it("schema 严格固定为 34，拒绝 33 和其他版本且发布门禁在写报告后失败关闭", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reply-regression-gate-"))
    temporaryDirectories.push(directory)
    const reports = ["empty.json", "failed.json", "regression.json"].map((name) => path.join(directory, name))
    const result = await evaluateModule(`
      const reports = ${JSON.stringify(reports)};
      const scenarios = [
        { selectedCount: 0, summary: { completed: 0, failed: 0, regressions: 0 } },
        { selectedCount: 1, summary: { completed: 0, failed: 1, regressions: 0 } },
        { selectedCount: 1, summary: { completed: 1, failed: 0, regressions: 1 } },
      ];
      const failures = [];
      for (let index = 0; index < scenarios.length; index += 1) {
        try {
          await regression.finalizeRegressionReport({
            replayMode: "historical_input_current_code_model",
            requestedSamples: scenarios[index].selectedCount,
            cases: [],
            summary: scenarios[index].summary,
          }, reports[index], scenarios[index].selectedCount);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : "unknown");
        }
      }
      for (const version of [33, 35]) {
        try {
          regression.assertRegressionSchemaVersion({ schemaVersion: () => version });
        } catch (error) {
          failures.push(error instanceof Error ? error.message : "unknown");
        }
      }
      process.stdout.write(JSON.stringify(failures));
    `)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      "回归发布门禁未通过：没有选中有效样本",
      "回归发布门禁未通过：存在执行失败",
      "回归发布门禁未通过：存在明确退步",
      "回归数据库 schemaVersion 必须为 34",
      "回归数据库 schemaVersion 必须为 34",
    ])
    for (const reportPath of reports) {
      const report = await readFile(reportPath, "utf8")
      expect(report).toContain("historical_input_current_code_model")
      expect(report).not.toMatch(/问题正文|回复正文|附件正文|credential|password/u)
      expect((await stat(reportPath)).mode & 0o777).toBe(0o600)
    }
  })
})
