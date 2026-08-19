# 群级影子学习模式实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为客服群增加可批量启用的影子学习模式，完整生成但绝不发送客服相关 Telegram 输出，并在 `2026-08-20 23:00 Asia/Shanghai` 根据拆分问题与可信真人答案生成只读学习报告。

**Architecture:** 复用现有问题拆分、线程、只读排查和回答 Worker，在 `support_threads` 固定群运行模式，在所有 Telegram 投递前通过统一策略阻断学习线程并将结果保存为影子终态。可信真人回复通过多对多匹配关联拆分问题；持久化报告 Worker 在固定截止时间使用记忆模型生成逐问题比较和汇总，不写入 AI 记忆或风格版本。

**Tech Stack:** Node.js 24、TypeScript、SQLite `node:sqlite`、Fastify、Zod、Vitest、原生 DOM 前端、Codex/Direct API 严格结构化模型适配器。

**Spec:** `docs/superpowers/specs/2026-08-19-shadow-learning-mode-design.md`

## Global Constraints

- 首份报告固定在 `2026-08-20 23:00 Asia/Shanghai`，即 `2026-08-20T15:00:00.000Z`。
- 学习模式对普通客服问题的 Telegram RPC 数量必须为零，包括进度、最终回复、技术告警和异常收口。
- `/start`、`/info` 保持现有行为。
- 群模式只影响新线程；每个线程固定创建时的运行模式。
- 对比单元必须是拆分后的问题线程和输入版本，不是整个群。
- 真人标准答案只来自已启用且 `learning_source_enabled=1` 的数字 Telegram ID。
- 学习报告不得自动更新固定规则、AI 记忆、人工纠正或真人口吻。
- 原始消息、影子答案、报告和附件遵守现有敏感信息、只读资源和保留期规则。

---

### Task 1: 群运行模式、线程固定模式和迁移

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/database.ts`
- Modify: `src/runtime/admin-service.ts`
- Modify: `src/runtime/backup-service.ts`
- Test: `tests/runtime/shadow-learning-schema.test.ts`
- Test: `tests/routes/group-batch-api.test.ts`

**Interfaces:**
- Produces: `groupOperationModeSchema = z.enum(["live", "learning"])`
- Produces: `RuntimeGroup.operationMode` and `SupportThread.answerOperationMode`
- Produces: batch patch field `operationMode?: "live" | "learning"`

- [ ] **Step 1: Write failing migration and admin tests**

Cover old database migration defaulting every group and existing thread to `live`, new support group accepting `learning`, technical alert group rejecting it, atomic batch rollback, portable import/export preservation, and thread creation pinning the current group mode.

- [ ] **Step 2: Run focused tests and verify schema/type failures**

Run:

```bash
node node_modules/vitest/vitest.mjs run tests/runtime/shadow-learning-schema.test.ts tests/routes/group-batch-api.test.ts
```

Expected: FAIL because operation mode columns and schema fields do not exist.

- [ ] **Step 3: Add the minimal schema and migration**

Add `operation_mode TEXT NOT NULL DEFAULT 'live' CHECK(operation_mode IN ('live','learning'))` to `telegram_groups` and `answer_operation_mode` with the same constraint to `support_threads`. Increment the unified schema version, add capability-aware migration, parse/write both fields, reject `learning` for `technical_alert`, and include the fields in migration databases.

- [ ] **Step 4: Add atomic admin batch support**

Extend group create/update/batch schemas. Validation must resolve the post-patch group and reject any technical alert group whose resulting operation mode is `learning`; the existing transaction must roll back the entire batch on the first invalid group.

- [ ] **Step 5: Run focused tests and typecheck**

Run the focused tests above and:

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime tests/runtime tests/routes/group-batch-api.test.ts
git commit -m "功能：增加群级学习运行模式"
```

### Task 2: 影子结果与零 Telegram 输出门禁

**Files:**
- Create: `src/support/shadow-output-policy.ts`
- Create: `src/support/shadow-result-store.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/database.ts`
- Modify: `src/replies/reply-service.ts`
- Modify: `src/support/answer-worker.ts`
- Modify: `src/support/technical-alert-service.ts`
- Modify: `src/support/deadline-service.ts`
- Test: `tests/support/shadow-learning-output.test.ts`

**Interfaces:**
- Produces: `ShadowOutputPolicy.isShadowThread(threadId: string): boolean`
- Produces: `ShadowResultStore.complete(input: ShadowResultInput): ShadowAnswerResult`
- Produces: `support_replies.status = "shadowed"` and `shadow_answer_results`

- [ ] **Step 1: Write a decision matrix test with a Telegram spy**

For `reply`, `minimal_clarification`, `ignore`, `escalate`, product change, human operation, cross-service handoff, progress due, hard deadline and model failure, create a learning-mode thread and assert zero calls to support reply, progress and technical-alert send ports; assert one auditable shadow result or real failure record. Add live-mode controls proving current sends still occur.

- [ ] **Step 2: Run the matrix and verify it fails on the first attempted send**

```bash
node node_modules/vitest/vitest.mjs run tests/support/shadow-learning-output.test.ts
```

Expected: FAIL because learning threads currently call Telegram delivery ports.

- [ ] **Step 3: Add shadow persistence**

Create `shadow_answer_results` with one row per `reply_id`, fixed thread/revision, structured decision, answer, simulated action JSON, completion status and timestamps. Add a distinct `shadowed` reply status that is not treated as delivered conversation context and cannot contain a Telegram reply message ID.

- [ ] **Step 4: Add the centralized policy and branch before every side effect**

The answer Worker must save the model result, transition the reply to `shadowed`, finish the generation without delivery, and never call technical alert or Telegram ports when the pinned thread is `learning`. Deadline/progress and failure-follow-up paths must consult the same policy. The policy reads only `support_threads.answer_operation_mode`, never the mutable group row.

- [ ] **Step 5: Prove no output ownership is created**

Extend the tests to query `telegram_output_ownership`, `support_thread_notifications`, and delivery rows and assert no sending/sent ownership exists for a shadow reply.

- [ ] **Step 6: Run tests and commit**

```bash
node node_modules/vitest/vitest.mjs run tests/support/shadow-learning-output.test.ts tests/support/technical-escalation.test.ts tests/support/response-depth.test.ts
git add src tests/support/shadow-learning-output.test.ts
git commit -m "功能：影子回答统一阻断 Telegram 输出"
```

### Task 3: 真人回复与拆分问题多对多匹配

**Files:**
- Create: `src/learning/shadow-human-matcher.ts`
- Create: `src/learning/shadow-human-link-store.ts`
- Modify: `src/support/learning-source-observer.ts`
- Modify: `src/support/thread-store.ts`
- Modify: `src/support/thread-lifecycle-service.ts`
- Modify: `src/codex/schemas.ts`
- Modify: `src/models/types.ts`
- Test: `tests/learning/shadow-human-matcher.test.ts`
- Test: `tests/support/learning-source-observer.test.ts`

**Interfaces:**
- Produces: `ShadowHumanMatcher.match(input): Promise<ShadowHumanMatchResult>`
- Produces: `ShadowHumanLinkStore.recordMany(messageEventId, matches)`
- Produces: `shadow_human_answer_links` unique on `(message_event_id, thread_id, input_revision)`

- [ ] **Step 1: Write failing association tests**

Cover one original message split into two threads, one真人 reply matching both, one matching only one, multiple replies matching one thread, direct unambiguous reply without model use, low-confidence/unknown IDs rejected, duplicate Telegram delivery idempotence, and live mode retaining current cancellation behavior.

- [ ] **Step 2: Run tests and observe single-thread association failure**

```bash
node node_modules/vitest/vitest.mjs run tests/learning/shadow-human-matcher.test.ts tests/support/learning-source-observer.test.ts
```

- [ ] **Step 3: Add deterministic candidate discovery**

Add a store query returning all thread relations for a referenced event and all eligible recent learning threads for the same group/service. A direct reference with exactly one eligible split thread records confidence `1`; multiple split candidates continue to the matcher instead of choosing the latest thread.

- [ ] **Step 4: Add strict structured matcher**

The matcher input contains only candidate thread IDs, each split question, the trusted真人 message and bounded prior group context. The output is `{ matches: [{ threadId, inputRevision, confidence, reason }] }`; reject unknown IDs, confidence below the fixed acceptance threshold, duplicate IDs and empty reasons.

- [ ] **Step 5: Preserve shadow generation while linking真人 evidence**

For a learning-mode candidate, do not call `takeOverFromHuman` and do not cancel the active answer. Persist links even when the影子 answer has not completed. For live threads retain current takeover/cancellation behavior.

- [ ] **Step 6: Run tests and commit**

```bash
node node_modules/vitest/vitest.mjs run tests/learning/shadow-human-matcher.test.ts tests/support/learning-source-observer.test.ts tests/support/human-takeover.test.ts
git add src tests/learning tests/support
git commit -m "功能：按拆分问题关联真人标准答案"
```

### Task 4: 结构化对比模型与报告数据

**Files:**
- Create: `src/learning/shadow-report-agent.ts`
- Create: `src/learning/shadow-report-store.ts`
- Modify: `src/codex/schemas.ts`
- Modify: `src/codex/executor.ts`
- Modify: `src/models/types.ts`
- Modify: `src/models/codex-cli-adapter.ts`
- Modify: `src/models/direct-api/direct-api-adapter.ts`
- Modify: `src/runtime/database.ts`
- Test: `tests/learning/shadow-report-agent.test.ts`
- Test: `tests/runtime/shadow-learning-schema.test.ts`

**Interfaces:**
- Produces: `ShadowComparisonAgent.compare(input): Promise<ShadowComparisonResult>`
- Produces: `ShadowReportAgent.summarize(input): Promise<ShadowReportSummary>`
- Produces: `shadow_comparisons`, `shadow_learning_reports`, `shadow_learning_report_items`

- [ ] **Step 1: Write strict schema and hostile-output tests**

Require per-question coverage, scores from `0` to `100`, explicit shared conclusions, factual gaps, reliability findings, style findings and recommendations. Reject unknown reply/thread IDs, missing coverage, secret-bearing output, free-form tool actions and any proposal to write memory or send Telegram.

- [ ] **Step 2: Run tests and verify missing agent/schema failures**

```bash
node node_modules/vitest/vitest.mjs run tests/learning/shadow-report-agent.test.ts
```

- [ ] **Step 3: Add no-resource structured model access**

Add a `shadow-learning-report` access mode that receives bounded JSON only and exposes no server, database, Redis, shell or Telegram tools. Both Codex CLI and direct API adapters must use the existing memory model binding without provider fallback.

- [ ] **Step 4: Add comparison and summary prompts**

Comparison prompts must instruct the model that真人答案 is a reference, not automatically true; distinguish unsupported真人 claims from confirmed differences using the影子 answer's recorded code/memory evidence. Summary prompts aggregate already validated comparisons and must never output executable changes.

- [ ] **Step 5: Add immutable report persistence**

Store report scope, cutoff, model snapshot, structured JSON, rendered Markdown, status, claim token and timestamps. Completed comparison/report content is append-only; regeneration creates a new report row.

- [ ] **Step 6: Run tests and commit**

```bash
node node_modules/vitest/vitest.mjs run tests/learning/shadow-report-agent.test.ts tests/models/model-gateway-snapshot.test.ts tests/runtime/shadow-learning-schema.test.ts
git add src tests/learning tests/runtime
git commit -m "功能：增加影子答案对比报告模型"
```

### Task 5: 指定时间报告 Worker、恢复与手动触发

**Files:**
- Create: `src/learning/shadow-report-worker.ts`
- Modify: `src/server.ts`
- Modify: `src/runtime/control-service.ts`
- Modify: `src/routes/model-config.ts`
- Test: `tests/learning/shadow-report-worker.test.ts`

**Interfaces:**
- Produces: `ShadowReportWorker.start()`, `stop()`, `runDue(now)`, `runNow(now)`, `status()`
- Consumes: `ShadowHumanLinkStore`, `ShadowResultStore`, comparison/report agents and report store

- [ ] **Step 1: Write scheduler and recovery tests**

Cover not running before `2026-08-20T15:00:00.000Z`, running once at/after the deadline, missed-time catch-up, two workers competing for one claim, stale claim recovery, fixed cutoff excluding late answers, model failure persistence, restart idempotence and no group mode changes.

- [ ] **Step 2: Run tests and verify missing worker failures**

```bash
node node_modules/vitest/vitest.mjs run tests/learning/shadow-report-worker.test.ts
```

- [ ] **Step 3: Implement persistent claim and batching**

Claim one due report atomically, collect stable per-question snapshots at the report cutoff, compare in bounded batches, heartbeat during model calls, and finalize only when every eligible item has a terminal comparison outcome.

- [ ] **Step 4: Wire lifecycle and control API**

Start after database/model initialization, stop and await active work during shutdown, expose status in runtime overview, and implement manual report creation without changing the original scheduled row or group modes.

- [ ] **Step 5: Run tests and commit**

```bash
node node_modules/vitest/vitest.mjs run tests/learning/shadow-report-worker.test.ts tests/runtime/daily-group-shutdown-worker.test.ts
git add src tests/learning
git commit -m "功能：定时生成影子学习报告"
```

### Task 6: 后台群配置、批量开启和学习报告页面

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/group-batch.ts`
- Modify: `web/src/views/accounts-groups.ts`
- Modify: `web/src/views/memories.ts`
- Create: `web/src/shadow-learning.ts`
- Modify: `src/routes/operations.ts`
- Test: `tests/app.test.ts`
- Test: `tests/routes/shadow-learning-report-api.test.ts`

**Interfaces:**
- Produces: batch form field `operationMode: "" | "live" | "learning"`
- Produces: `GET /api/learning-reports`, `GET /api/learning-reports/:id`, `POST /api/learning-reports`

- [ ] **Step 1: Write failing UI helper and API tests**

Verify labels “正式回复/学习模式”, batch patch generation, technical group rejection, single-group persistence, report cursor listing, report detail stable ordering, manual generation, and sensitive raw fields absent from list payloads.

- [ ] **Step 2: Run tests and verify missing fields/routes**

```bash
node node_modules/vitest/vitest.mjs run tests/app.test.ts tests/routes/shadow-learning-report-api.test.ts
```

- [ ] **Step 3: Add group controls**

Add the single-group selector, row badge and batch selector. Batch copy must explicitly say learning mode generates answers without sending; switching to live affects only new questions.

- [ ] **Step 4: Add report list and detail**

Place “学习报告” inside AI 记忆库, show cutoff/time range and aggregate metrics, then render each拆分问题 with影子答案、真人答案、scores、findings、evidence and match confidence. Do not add an automatic apply button.

- [ ] **Step 5: Run tests, web typecheck and commit**

```bash
node node_modules/vitest/vitest.mjs run tests/app.test.ts tests/routes/shadow-learning-report-api.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit
git add web src/routes tests
git commit -m "界面：支持批量学习模式和学习报告"
```

### Task 7: 保留期、迁移库和端到端回归

**Files:**
- Modify: `src/replies/retention-service.ts`
- Modify: `src/runtime/backup-service.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Test: `tests/replies/retention-learning-observation.test.ts`
- Test: `tests/runtime/reference-learning-schema.test.ts`
- Test: `tests/support/real-production-scenario-matrix.test.ts`

**Interfaces:**
- Consumes all previous tasks.
- Produces complete retention/import/export behavior and project documentation.

- [ ] **Step 1: Add failing retention and portable migration tests**

Verify live shadow rows retain stable redacted report summaries after expired raw messages are removed, live observation foreign keys become nullable where required, portable databases preserve group modes and completed reports, and account credentials remain excluded.

- [ ] **Step 2: Add production scenario matrix**

Cover split multi-question messages, human multi-match, shadow generation before/after human response, mode switching mid-flight, scheduled report cutoff, manual live enable after report, live reply after switch and identity command behavior.

- [ ] **Step 3: Implement retention/backup and update docs**

Use small batches, never delete rows held by running shadow/report claims, preserve append-only terminal audit, and document the exact operator flow for batch learning mode, report review and manual live switch.

- [ ] **Step 4: Run focused tests**

```bash
node node_modules/vitest/vitest.mjs run tests/replies/retention-learning-observation.test.ts tests/runtime/reference-learning-schema.test.ts tests/support/real-production-scenario-matrix.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src README.md AGENTS.md tests
git commit -m "文档：封闭影子学习模式运行闭环"
```

### Task 8: 完整验证

**Files:**
- Verify only

- [ ] **Step 1: Run full typecheck**

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit
```

- [ ] **Step 2: Run all tests**

```bash
node node_modules/vitest/vitest.mjs run
```

- [ ] **Step 3: Build server and web assets**

```bash
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node scripts/copy-web-assets.mjs
node node_modules/typescript/bin/tsc -p tsconfig.web.json
```

- [ ] **Step 4: Verify repository state and migration target**

```bash
git diff --check
git status --short
git log --oneline --max-count=10
```

Expected: no uncommitted implementation changes, all checks exit `0`, and the first pending report time resolves to `2026-08-20 23:00 Asia/Shanghai`.
