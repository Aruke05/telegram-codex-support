# 客服线程语义输出所有权 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 SQLite 持久化线程级进度与人工接管所有权，阻止 EZPay 场景中的重复稍等、重复转技术和终态线程误重开。

**Architecture:** 新增 `support_thread_output_claims` 作为语义级 CAS，实际发送状态继续复用 reply、notification 与 Telegram output ownership。所有进度入口统一到 notification owner；所有升级入口在准备 reply 时领取 handoff；路由获得完整时间线和终态信息并失败关闭。

**Tech Stack:** TypeScript、Node.js 22.16+、SQLite `node:sqlite`、Zod、Vitest、pnpm

**Spec:** `docs/superpowers/specs/2026-08-28-thread-output-ownership-design.md`

## Global Constraints

- 只能修改 `/Users/oldwang/Desktop/project/sfzf-telegram-ai-support` 自身代码和本地测试数据；生产服务器、生产数据库、四方支付代码和 MagicBook 只读。
- 不使用关键词、正则、相似度、分数或其他确定性业务语义门槛判断 `1`、责任、异常、忽略或升级；业务语义由结构化路由模型判断，代码只执行状态和 schema 门禁。
- `telegram_output_ownership` 继续是 Telegram RPC 是否开始及发送结果的唯一事实源，不解析客服文案或 `decision_reason` 猜测投递状态。
- 同一线程 progress 和 handoff 各最多一个持久 owner；`sending`、`sent`、`unknown` 不得换 owner 或盲目重发。
- 已 handoff 的线程可追加审计，但 status、revision 和生成时间字段不得被重置，不唤醒回答 worker。
- 技术角色只按后台启用的精确 Telegram 数字 user ID 识别，不按用户名或话术猜测。
- SQLite 版本升到 33，并按表、列、约束、索引和外键能力校验迁移谱系；完整迁移 SQLite 必须保留 claims。
- 按 TDD 执行：每个行为先运行会因缺少实现而失败的测试，再写最小实现并复跑。
- Git 提交信息、状态和推送说明使用中文；最终使用 `pnpm publish:remotes`，不得把内部历史直接推送到公开仓库。

---

### Task 1: SQLite 语义所有权与存储原语

**Files:**
- Modify: `src/version.ts`
- Modify: `src/runtime/database.ts`
- Modify: `src/runtime/backup-service.ts`
- Modify: `src/support/thread-store.ts`
- Test: `tests/runtime/thread-output-claim-schema.test.ts`
- Test: `tests/support/human-takeover.test.ts`

**Interfaces:**
- Produces: `ThreadOutputClaimKind`, `ThreadOutputClaimSource`, `SupportThreadOutputClaim`。
- Produces: `claimProgressNotification(threadId, inputRevision, source, dueAt, now): SupportThreadNotification | null`。
- Produces: `claimHandoff(replyId, source, now): boolean`，同 reply 恢复返回 true，其他 reply 冲突返回 false。
- Produces: `hasHandoffClaim(threadId): boolean`、`handoffSource(threadId): ThreadOutputClaimSource | null`。
- Produces: `releaseFailedProgressClaim(notificationId, now): boolean`，仅在没有 `sending/sent/unknown` Telegram ownership 时释放匹配 owner。

- [ ] **Step 1: 写 schema 32→33 与 owner 唯一性失败测试**

创建 `tests/runtime/thread-output-claim-schema.test.ts`，至少断言：新库版本为 33；表列、两个 UNIQUE owner、复合主键、外键和 CHECK 完整；v32 运行库及迁移库升级；历史 notification、human priority、status request、单次 handoff 和重复 handoff 都回填唯一 owner；同线程第二个 progress/handoff owner 被拒绝；同 reply 恢复 handoff 幂等；portable export/import 保留两类 claim；已知旧库缺表时迁移，伪造残缺同名表时拒绝打开。

- [ ] **Step 2: 运行 schema 测试确认 RED**

Run: `pnpm test tests/runtime/thread-output-claim-schema.test.ts`

Expected: FAIL，因为 schema 仍为 32 且表和 API 不存在。

- [ ] **Step 3: 实现 v33 schema、结构断言和迁移链**

在 `src/runtime/database.ts` 按 spec 的 SQL 新增表，添加 `assertSupportThreadOutputClaimStructure`，并在 `RuntimeDatabase.open/openPortable` 的迁移和当前结构检查中调用。`migrateV32ToV33` 使用 `BEGIN IMMEDIATE`、`CREATE TABLE IF NOT EXISTS`、结构化历史状态回填和版本更新；缺 notification 的旧 progress 用 `randomUUID()` 创建严格合法的合成 notification，并补齐其 Telegram ownership 关联；重复旧 handoff 只选择最早结构化 owner。创建和回填后必须结构断言，不能只依据版本号或解析客服文案。

- [ ] **Step 4: 实现迁移库复制与清理顺序**

在 `portableTables`、`sensitiveScanTables`、import capability detection 和 copy 顺序中加入 claims。导入必须先复制 replies/notifications，再复制 claims，最后复制 Telegram ownership；`clearPortableData` 必须先删 claims，再删 replies/notifications/threads。

- [ ] **Step 5: 写存储 CAS 失败测试**

在 `tests/support/human-takeover.test.ts` 先覆盖：三个 progress source 竞争只产生一个 owner；handoff 同 reply 可恢复、不同 reply 不可领取；progress 明确失败且无 RPC ownership 可释放；`unknown`、`sending`、`sent` 不释放。

- [ ] **Step 6: 运行存储测试确认 RED**

Run: `pnpm test tests/support/human-takeover.test.ts -t "线程语义输出所有权"`

Expected: FAIL，因为 `SupportThreadStore` 尚无上述 CAS 原语。

- [ ] **Step 7: 实现最小存储原语并跑 GREEN**

使用 `RuntimeDatabase.transaction()` 和 `INSERT ... ON CONFLICT DO NOTHING` 实现接口。`hasStartedProgress` 读取 `(thread_id,'progress')` claim；v32 的所有既有发送事实由迁移回填，不保留绕开 claim 的并行判断。失败释放必须同时匹配 notification owner，并用 `NOT EXISTS` 排除 `sending/sent/unknown` ownership。

- [ ] **Step 8: 运行 Task 1 测试**

Run: `pnpm test tests/runtime/thread-output-claim-schema.test.ts tests/support/human-takeover.test.ts`

Expected: PASS。

- [ ] **Step 9: 提交 Task 1**

```bash
git add src/version.ts src/runtime/database.ts src/runtime/backup-service.ts src/support/thread-store.ts tests/runtime/thread-output-claim-schema.test.ts tests/support/human-takeover.test.ts
git commit -m "修复：持久化线程语义输出所有权"
```

### Task 2: 三条进度链统一到唯一 notification owner

**Files:**
- Modify: `src/support/thread-store.ts`
- Modify: `src/support/deadline-service.ts`
- Modify: `src/support/thread-coordinator.ts`
- Modify: `src/support/thread-router.ts`
- Modify: `src/server.ts`
- Test: `tests/support/human-takeover.test.ts`
- Test: `tests/support/sender-focus-routing.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `claimProgressNotification` 与 `releaseFailedProgressClaim`。
- Produces: `claimPendingProgressNotification(now): SupportThreadNotification | null`，先恢复既有 pending，再创建到期 scheduled owner。
- Produces: 状态催促 callback 接收 `notification`，不再创建 side reply，不再接收模型生成的 `progressReply`。
- Produces: 人工优先 claim 返回并绑定唯一 progress notification。

- [ ] **Step 1: 写三入口并发和恢复失败测试**

在 `human-takeover.test.ts` 先覆盖：scheduled、human priority、status request 任意顺序竞争都只有一个 notification/claim；pending 重启后沿原 notification 发送；sending 且已有 ownership 恢复 unknown；发送明确失败可由最新版本重新领取；unknown 不重发。

- [ ] **Step 2: 写状态催促短文案失败测试**

在 `sender-focus-routing.test.ts` 断言：`follow_up + status_only` 只发送 `operatorCopy.progress` 经 profile 处理后的短文案；不创建新 reply；第二次状态催促不再调用 sender；单独 `1` 的非进度路由不会触发发送。

- [ ] **Step 3: 运行 Task 2 定点测试确认 RED**

Run: `pnpm test tests/support/human-takeover.test.ts tests/support/sender-focus-routing.test.ts`

Expected: 新增测试 FAIL，显示三个入口仍分别领取或状态催促仍创建 side reply。

- [ ] **Step 4: 统一 scheduled 和 human priority**

`claimDueProgress` 先返回已有有效 pending progress notification，再创建 scheduled owner。`claimDueHumanPriority` 必须通过相同 notification owner 领取；冲突时把人工优先状态推进到 claimed 并继续 AI，不发送第二条。两条发送路径都携带 notificationId，完成/失败统一更新 notification。

- [ ] **Step 5: 统一 status request**

协调器只把结构化 `status_only` 当成状态催促，调用 store 创建/复用即时 progress notification。`server.ts` 直接发送 `humanizeOperatorAnswer(operatorCopy.progress, "", thread.operatorStyleProfile)`，Telegram ownership 绑定 notification；移除 `progressReply` 的发送依赖和 side reply 创建。

- [ ] **Step 6: 完成失败与重启语义**

明确发送失败调用 `failNotification` 并安全释放 owner；Telegram 结果未知调用 `markNotificationUnknown`；无 RPC 的 interrupted sending 恢复 pending，已有 ownership 的 interrupted sending 恢复 unknown。被新版本替代且未开始发送的 pending notification 标记 failed 并释放 claim。

- [ ] **Step 7: 运行 Task 2 测试**

Run: `pnpm test tests/support/human-takeover.test.ts tests/support/sender-focus-routing.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交 Task 2**

```bash
git add src/support/thread-store.ts src/support/deadline-service.ts src/support/thread-coordinator.ts src/support/thread-router.ts src/server.ts tests/support/human-takeover.test.ts tests/support/sender-focus-routing.test.ts
git commit -m "修复：统一客服线程一次性进度回复"
```

### Task 3: Handoff 终态锁、完整路由与 EZPay 回放

**Files:**
- Modify: `src/codex/schemas.ts`
- Modify: `src/replies/reply-service.ts`
- Modify: `src/support/answer-worker.ts`
- Modify: `src/support/thread-store.ts`
- Modify: `src/support/thread-router.ts`
- Modify: `src/support/thread-coordinator.ts`
- Test: `tests/support/sender-focus-routing.test.ts`
- Test: `tests/support/human-takeover.test.ts`
- Test: `tests/support/real-production-scenario-matrix.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `claimHandoff`、`hasHandoffClaim`、`handoffSource`。
- Produces: `appendAuditMessage(...)`，只追加事件并保持 terminal state/revision。
- Produces: `SenderRouteFocusContext.status`、`handoffSource` 与 `ThreadRouteInput.timeline`。
- Produces: `ThreadRouteResult.messageIntent`，值为 `actionable | progress_request | non_actionable | unclear`。

- [ ] **Step 1: 写 handoff exactly-once 失败测试**

在 `human-takeover.test.ts` 覆盖：普通升级、产品需求、人工操作、服务接管、已发 progress 后失败和 hard deadline 都必须在准备 reply 的同一事务领取 handoff；第二 reply 无法准备或告警；同 reply 崩溃恢复继续；已存在 handoff 的线程不会被 `appendMessage` 重开。

- [ ] **Step 2: 写终态路由和 EZPay 失败测试**

在 `sender-focus-routing.test.ts` 与 `real-production-scenario-matrix.test.ts` 用脱敏顺序覆盖：一次 progress、一次 handoff、handoff 后业务补充、连续两个 `1`。断言 handoff 后消息只审计，revision/status 不变，wake/send/alert 均为零；完整独立新问题创建新线程；已配置技术角色回复触发人工接管且零机器人输出。

- [ ] **Step 3: 写路由完整性和失败关闭测试**

断言 router 收到最近 30 条混合 inbound/outbound timeline、senderRole、focus status 和 handoff source；`messageIntent` 与 action/effect 不一致时 schema 拒绝；`uncertain` 没有两个有效候选时不建线程；router 连续失败两次时事件记 ignored，线程数不变。

- [ ] **Step 4: 运行 Task 3 定点测试确认 RED**

Run: `pnpm test tests/support/human-takeover.test.ts tests/support/sender-focus-routing.test.ts tests/support/real-production-scenario-matrix.test.ts`

Expected: 新增测试 FAIL，因为 escalated 仍能 reopen、timeline 未注入且路由失败仍创建新线程。

- [ ] **Step 5: 在升级准备事务中领取 handoff**

扩展 `ReplyService.prepareTechnicalEscalation` 接受明确 `ThreadOutputClaimSource`。先确认当前 reply/thread revision，再调用 `claimHandoff`；只有相同 reply owner 才能继续更新 reply。`AnswerWorker` 将 `decision.escalationType` 原样映射，系统失败使用 `failure_after_progress`，hard deadline 使用 `hard_deadline`。

- [ ] **Step 6: 实现 terminal audit append**

`appendMessage` 对存在 handoff claim 的线程返回 null，不能重置终态。新增 `appendAuditMessage` 在事务中插入 `support_thread_messages relation='supplement'`，更新 `latest_message_at/updated_at` 和事件 route 状态，但不改 revision、status、settle/generation/closed 字段。协调器对 handoff focus 的 `follow_up` 使用该方法且不 wake。

- [ ] **Step 7: 注入完整时间线与 messageIntent schema**

扩展 `ThreadRouteTimelineEntry` 包含 `senderRole`；`routeDecision` 每次传入 `store.listRouteTimeline(group,service,latestAt,30)`。focus context 使用当前 thread status、handoff source 和混合 timeline。更新 Zod 与 JSON Schema，使 action、effect 和 `messageIntent` 的关系按 spec 严格校验；进度文案不再由 router 生成。

- [ ] **Step 8: 改为穷尽路由和失败关闭**

`routeDecision` 最多调用 router 两次；两次失败将本批事件更新为 ignored 并返回 null。协调器显式处理每个 action，不保留 catch-all create；`uncertain` 缺少合法澄清条件时静默 ignored；只有 `new_thread/split` 创建线程。

- [ ] **Step 9: 运行 Task 3 测试**

Run: `pnpm test tests/support/human-takeover.test.ts tests/support/sender-focus-routing.test.ts tests/support/real-production-scenario-matrix.test.ts`

Expected: PASS。

- [ ] **Step 10: 提交 Task 3**

```bash
git add src/codex/schemas.ts src/replies/reply-service.ts src/support/answer-worker.ts src/support/thread-store.ts src/support/thread-router.ts src/support/thread-coordinator.ts tests/support/human-takeover.test.ts tests/support/sender-focus-routing.test.ts tests/support/real-production-scenario-matrix.test.ts
git commit -m "修复：锁定已转技术线程并关闭错误路由"
```

### Task 4: 全量验证、版本记录与发布

**Files:**
- Modify: `src/version.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Verify: all changed files

**Interfaces:**
- Consumes: Tasks 1–3 的完整行为。
- Produces: 可构建、可迁移、已审查的发布提交。

- [ ] **Step 1: 升级 patch 版本并记录中文变更**

把 `src/version.ts`、`package.json` 和 `pnpm-lock.yaml` 的应用版本从 `2.2.3` 升到 `2.2.4`。

- [ ] **Step 2: 运行完整验证**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: 所有命令 exit 0，无测试失败、类型错误、构建错误或空白错误。

- [ ] **Step 3: 检查计划覆盖与工作区**

运行 `git status --short`、`git diff --stat`、`git log --oneline`，确认没有临时文件、生产数据、凭据或不相关改动；逐条复核 spec 验收场景。

- [ ] **Step 4: 提交发布版本**

```bash
git add src/version.ts package.json pnpm-lock.yaml
git commit -m "发布：升级版本至 2.2.4"
```

- [ ] **Step 5: 完整代码审查**

对起始提交到当前 HEAD 进行 spec、并发、恢复、SQLite 谱系、迁移库和 Telegram exactly-once 审查。Critical/Important 必须修复并重跑相关测试。

- [ ] **Step 6: 按项目发布脚本推送**

Run: `pnpm publish:remotes`

Expected: 内部 Git 远程收到完整分支历史，GitHub 收到当前提交生成的无内部历史公开快照；两段推送都成功。
