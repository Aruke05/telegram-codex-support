# AI 对话终止与双仓错峰同步实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让后台 AI 对话支持真正终止和首次发送自动建会话，并让所有客服回答只读最近成功代码快照，双仓由每 30 分钟单并发错峰任务更新。

**Architecture:** 后台对话以 SQLite 明确保存 `cancelled` 终态，API 将会话首轮创建合并为原子事务，工作器通过现有 AbortController 中断执行。代码同步服务增加无网络的快照读取边界和全局远端串行队列；回答与学习只读快照，持久化调度器每分钟领取一个到期服务并把下次时间推进 30 分钟。

**Tech Stack:** Node.js 22、TypeScript 5.9、Fastify 5、SQLite、Zod 4、原生 TypeScript/CSS、Vitest、systemd

## Global Constraints

- Peakpay 永久排除。
- Telegram 客服回答、后台 AI 对话和自动学习不得触发 Git fetch。
- 回答使用当前配置对应的最近一次成功完整双仓快照，即使快照可能最多落后一个定时周期也继续回答。
- 定时同步每个服务间隔 30 分钟，每分钟最多领取 1 个服务，所有远端同步全局最大并发为 1，同一服务双仓顺序拉取。
- 手动同步保留，但必须进入同一个全局串行队列。
- 终止状态必须持久化并实际触发 AbortSignal，不得只修改页面。
- 首次发送必须在一个 SQLite 事务内创建会话和首轮，不得留下孤立空会话。
- 不提交测试文件或测试代码；临时 RED/GREEN 测试提交前删除。
- Git 提交信息、推送说明和状态反馈使用中文。
- 最终只部署到 `DEPLOY_HOST`，类型检查、测试、构建和页面验收在部署目标完成。

---

### Task 1: 对话取消状态与原子首轮

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/database.ts`
- Modify: `src/runtime/backup-service.ts`
- Modify: `src/admin-chat/store.ts`
- Temporary test: `tests/tmp-admin-chat-cancellation.test.ts`，提交前删除

**Interfaces:**
- Produces: `AdminChatTurnStatus = "pending" | "generating" | "completed" | "failed" | "cancelled"`
- Produces: `AdminChatStore.createSessionWithTurn(serviceId, question): { session; turn }`
- Produces: `AdminChatStore.cancelTurn(turnId): AdminChatTurn`

- [ ] **Step 1: 写临时失败测试**

测试必须覆盖：

```ts
const created = store.createSessionWithTurn(service.id, "第一笔订单为什么失败")
expect(created.session.title).toBe("第一笔订单为什么失败")
expect(created.turn.status).toBe("pending")
expect(store.listSessions(service.id)).toHaveLength(1)

expect(store.cancelTurn(created.turn.id).status).toBe("cancelled")
expect(store.cancelTurn(created.turn.id).status).toBe("cancelled")
expect(store.claimNext()).toBeNull()
```

另创建一轮并领取为 `generating`，终止后验证 `completed_at` 非空，且 `completeTurn` 不能覆盖 `cancelled`。

- [ ] **Step 2: 运行临时测试确认 RED**

Run: `pnpm vitest run tests/tmp-admin-chat-cancellation.test.ts`

Expected: `createSessionWithTurn` 或 `cancelTurn` 不存在，测试失败。

- [ ] **Step 3: 增加 schema 13 迁移**

新库 `admin_chat_turns.status` CHECK 加入 `cancelled`，元数据版本改为 13。`migrateV12ToV13` 在事务中重建 `admin_chat_turns`，逐字段复制已有数据，再恢复：

```sql
CREATE INDEX admin_chat_turns_work_idx ON admin_chat_turns(status,created_at,id);
CREATE UNIQUE INDEX admin_chat_turns_one_active_idx
  ON admin_chat_turns(session_id) WHERE status IN ('pending','generating');
```

`RuntimeDatabase.open` 和 `openPortable` 都执行 12→13；导入校验要求版本 13。

- [ ] **Step 4: 实现存储接口**

把服务校验和会话插入拆成私有小函数。`createSessionWithTurn` 使用一个 `database.transaction`：

```ts
const session = this.insertSession(this.readEnabledService(serviceId))
const turn = this.createTurnForSession(session, question)
return { session: this.readSession(session.id), turn }
```

`cancelTurn` 只条件更新 `pending` 或 `generating`：

```sql
UPDATE admin_chat_turns
SET status='cancelled',error_code='admin_chat_cancelled',decision_reason='本轮已由用户终止',updated_at=?,completed_at=?
WHERE id=? AND status IN ('pending','generating')
```

更新为 0 行时返回当前真实终态，实现幂等和完成竞争保护。

- [ ] **Step 5: 运行 GREEN 并提交**

Run: `pnpm vitest run tests/tmp-admin-chat-cancellation.test.ts`

Expected: 全部通过。删除临时测试后提交：

```bash
git add src/runtime/types.ts src/runtime/database.ts src/runtime/backup-service.ts src/admin-chat/store.ts
git commit -m "功能：增加 AI 对话终止状态与原子首轮"
```

---

### Task 2: 终止 API 与工作器中断

**Files:**
- Modify: `src/admin-chat/worker.ts`
- Modify: `src/routes/admin-chat.ts`
- Modify: `src/app.ts`
- Modify: `web/src/api.ts`
- Temporary test: `tests/tmp-admin-chat-routes.test.ts`，提交前删除

**Interfaces:**
- Produces: `AdminChatWorker.cancel(turnId): boolean`
- Produces: `POST /api/admin-chat/turns`
- Produces: `POST /api/admin-chat/turns/:id/cancel`
- Produces: `api.createAdminChatConversation(serviceId, question)` 与 `api.cancelAdminChatTurn(turnId)`

- [ ] **Step 1: 写 API 临时失败测试并确认 RED**

通过 Fastify inject 验证：首次提交返回 202 和一组 session/turn；取消 pending 返回 `cancelled`；第二次取消仍返回 `cancelled`；worker.cancel 收到轮次 ID。

Run: `pnpm vitest run tests/tmp-admin-chat-routes.test.ts`

Expected: 新路由返回 404。

- [ ] **Step 2: 实现路由和工作器取消**

`AdminChatWorker.cancel` 查找 `controllers.get(turnId)` 并调用 `abort(new Error("用户终止后台对话"))`。`process` 捕获到 `controller.signal.aborted` 时直接返回，不再进入 `safeFailure`。

首发路由调用 `store.createSessionWithTurn` 后 `worker.wake()`。取消路由先调用 `store.cancelTurn`，仅当原状态可能在运行时调用 `worker.cancel`，然后发布事件并返回公开轮次。

- [ ] **Step 3: 运行 GREEN 并提交**

删除临时测试后提交：

```bash
git add src/admin-chat/worker.ts src/routes/admin-chat.ts src/app.ts web/src/api.ts
git commit -m "功能：接通 AI 对话终止接口"
```

---

### Task 3: 首发交互与紧凑布局

**Files:**
- Modify: `web/src/views/admin-chat.ts`
- Modify: `web/styles.css`

**Interfaces:**
- Consumes: Task 2 的两个新 API
- Preserves: 已有会话内继续提问、新对话、事件流刷新、失败重试和移动端抽屉

- [ ] **Step 1: 建立一次性页面失败检查**

在修改前部署版本静态资源上验证以下选择器/行为不存在：

```text
.admin-chat-conversation.is-starting
.admin-chat-cancel
未选择会话时 textarea:not([disabled])
```

- [ ] **Step 2: 移动服务选择器**

DOM 顺序改为：页面标题 → console → toolbar 内的服务选择、会话上下文、新对话。桌面工具栏使用紧凑 grid；`max-width: 820px` 时服务选择占一整行，其余操作在下一行。

- [ ] **Step 3: 实现 starting 布局**

`renderConversation` 根据 `!detail || detail.turns.length === 0` 切换 `conversationPane.classList.toggle("is-starting", starting)`。starting 状态取消消息区满高和 composer sticky，把引导、输入框限制在相同的 `min(760px, 100%)` 宽度并靠近排列。

- [ ] **Step 4: 首发自动建会话**

`setComposerState` 在存在 `selectedServiceId` 且没有活跃轮次时启用输入框，不再要求 `detail`。

submit 分支：

- 有 `detail`：继续调用已有 create turn API。
- 无 `detail`：调用 `createAdminChatConversation(selectedServiceId, value)`，成功后把返回会话插入 sessions、构造 detail、清空输入并打开会话；失败时保留原问题。

- [ ] **Step 5: 增加终止卡片**

pending/generating 卡片增加 `终止` 次要危险按钮。调用取消 API 后用返回的 `cancelled` 轮次替换当前轮次。`cancelled` 使用中性卡片显示 `本轮已终止` 和 `重新排查`，不显示系统故障。

- [ ] **Step 6: 提交页面改动**

```bash
git add web/src/views/admin-chat.ts web/styles.css
git commit -m "优化：完善 AI 对话首发与终止交互"
```

---

### Task 4: 当前快照读取与全局串行同步

**Files:**
- Modify: `src/git-sync/project-service.ts`
- Modify: `src/git-sync/hourly-worker.ts`
- Modify: `src/support/investigation-service.ts`
- Modify: `src/support/answer-worker.ts`
- Modify: `src/learning/worker.ts`
- Modify: `src/support/agent.ts`
- Temporary test: `tests/tmp-staggered-code-sync.test.ts`，提交前删除

**Interfaces:**
- Produces: `ProjectCodeSyncService.readCurrentSnapshot(serviceId): ProjectCodeSnapshot`
- Preserves: `syncService(serviceId, { trigger: "manual" | "hourly" })`
- Changes: `SupportInvestigationService` 和 `MemoryLearningWorker` 只消费 `readCurrentSnapshot`

- [ ] **Step 1: 写同步失败测试并确认 RED**

临时测试使用受控 CommandRunner 记录同时运行数和调用顺序，验证旧实现会并发同步两个仓库或同时领取多个服务，并验证 `readCurrentSnapshot` 尚不存在。

Run: `pnpm vitest run tests/tmp-staggered-code-sync.test.ts`

Expected: 缺少接口或最大并发大于 1。

- [ ] **Step 2: 实现无网络快照读取**

复用现有 `boundRepositories`、`configurationFingerprint`、`snapshotFromRow` 校验。查询当前 service/branch/pair fingerprint 最近发布快照，并读取最近成功批次 ID。不得写 `service_code_sync_batches`、`code_sync_runs` 或调度表。

- [ ] **Step 3: 回答和学习切换为只读快照**

`syncStableCode` 改为最多三次读取当前快照并确认配置仍一致，不再调用 `syncService`。轨迹标题和进度文案改为 `读取当前双仓快照`，包含 `publishedAt`，禁止声称本轮刚拉取。

`MemoryLearningWorker` 在启用代码证据时调用 `readCurrentSnapshot`；失败则保持 `snapshot=null`，不触发网络。

- [ ] **Step 4: 实现全局串行远端队列**

`ProjectCodeSyncService.syncService` 在同服务 in-flight 去重外增加全局 Promise tail。每个真正远端同步等待前一个释放后才进入 `syncLatest`，并在 finally 释放。`syncLatest` 用 for-of 顺序调用两个 `syncRepository`，替代 `Promise.allSettled`。

- [ ] **Step 5: 改为半小时单服务调度**

`hourMs` 改为 `scheduleIntervalMs = 30 * 60 * 1000`，`maximumConcurrency` 改为 1；扫描仍每 60 秒一次。`claim` 一次只取一个到期服务并把下次到期推进 30 分钟。`markScheduleSuccess` 同样推进 30 分钟。

- [ ] **Step 6: 运行 GREEN 并提交**

删除临时测试后提交：

```bash
git add src/git-sync/project-service.ts src/git-sync/hourly-worker.ts src/support/investigation-service.ts src/support/answer-worker.ts src/learning/worker.ts src/support/agent.ts
git commit -m "优化：改为半小时单并发双仓同步"
```

---

### Task 5: 固定规则、后台文案与部署验证

**Files:**
- Modify: `AGENTS.md`
- Modify: `src/support/technical-alert-service.ts`
- Modify: `web/src/views/runtime.ts`
- Modify: `web/src/views/settings.ts`

- [ ] **Step 1: 更新当前固定规则**

把 `每次问题前同步` 改为：回答使用最近一次定时成功的当前配置双仓快照；后台每 30 分钟分批同步；定时失败时保留旧快照并继续回答。

- [ ] **Step 2: 更新管理文案**

运行页固定开关改成只读说明 `回答使用定时双仓快照`；状态空文案改成 `每个启用服务每 30 分钟分批同步`；技术告警从 `每小时` 改成 `定时代码同步`；系统设置卡片同步更新。

- [ ] **Step 3: 静态检查并提交**

Run: `git diff --check && rg -n "回答前同步双仓共同分支|每个启用服务每小时自动同步|每小时代码同步" AGENTS.md src web`

Expected: diff 无格式问题，旧运行文案无命中。

```bash
git add AGENTS.md src/support/technical-alert-service.ts web/src/views/runtime.ts web/src/views/settings.ts
git commit -m "文档：统一半小时快照同步规则"
```

- [ ] **Step 4: 推送并在服务器构建**

推送当前 HEAD 到 `origin/telegram-ai-support`。在 `DEPLOY_HOST` 以 `telegram-support` 执行：

```bash
pnpm typecheck
pnpm test
pnpm build
```

全部通过后重启 `telegram-codex-support.service`。

- [ ] **Step 5: 服务器一次性回归**

使用服务器运行 SQLite 临时副本和实际 API，确认 schema 13、首发原子性、pending/generating/cancelled、重复终止、回答无 answer Git 批次、调度 30 分钟和最大远端并发 1。

- [ ] **Step 6: 页面和运行状态验收**

验证桌面、窄屏、浅色和深色；确认服务选择与空会话输入区紧凑、首次发送直接建会话、生成中可终止、无横向溢出。最后确认：

```text
systemctl is-active telegram-codex-support.service = active
GET /health = status ok
服务器提交 = 远端 telegram-ai-support 提交
工作区无未提交文件
```
