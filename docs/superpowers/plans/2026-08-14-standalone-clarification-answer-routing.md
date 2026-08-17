# 裸短答案续接问题线程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一发送人在机器人最少信息追问后直接发送的裸短答案确定性续接唯一原线程，不再被路由模型当成闲聊忽略。

**Architecture:** 在 `SupportThreadStore` 增加唯一待补充线程查询，复用现有 30 分钟归档边界和已持久化的 `minimal_clarification` 决策标记。`SupportThreadCoordinator` 在 Telegram 显式回复匹配失败后、模型路由前调用该查询；唯一命中时沿现有 append/reopen 路径追加整批消息，歧义时保持原模型路由。

**Tech Stack:** TypeScript、Node.js 24 `node:sqlite`、SQLite、Vitest、现有 `SupportThreadStore` / `SupportThreadCoordinator`

## Global Constraints

- 显式 `reply_to_message_id` 始终优先于裸短答案兜底。
- 只允许同群、同服务、同发送人、唯一有效线程自动续接。
- 线程仍按现有 30 分钟规则归档，不新增第二套时间配置。
- 延迟到达的旧消息使用当前处理时间判断归档，不能按消息时间复活已过期线程。
- 不跨发送人吸附；多个候选时继续调用现有模型路由。
- 不新增 SQLite 表或 schema 版本。
- 不修改技术告警投递链路。
- 按项目要求不提交临时测试文件或测试代码；临时回归用例完成红绿验证后删除。
- 不在本机启动或重启常驻服务；上线只在既有 Linux systemd 服务执行。

---

### Task 1: 唯一待补充线程查询

**Files:**
- Modify: `src/support/thread-store.ts`
- Temporary Test: `.tmp-standalone-clarification-routing.test.ts`

**Interfaces:**
- Consumes: `groupId: string`、`serviceId: string`、`senderUserId: string`、可选 `reference: string | Date`
- Produces: `findUniqueMinimalClarificationThread(groupId, serviceId, senderUserId, reference?): SupportThread | null`

- [ ] **Step 1: 写查询层失败用例**

临时测试先建立一个 `answered` 线程和最终 `replied` 记录，记录必须满足：

```ts
harness.replies.transition(reply.id, "replied", {
  telegramReplyMessageId: "3173",
  operatorDeliveryStatus: "sent",
  answer: "新账号要用的用户名发我一下",
  decisionReason: "缺少用户名\n对话判断 sentiment=neutral situation=new_request strategy=minimal_clarification need=创建运营账号",
})
```

断言同一发送人得到该线程：

```ts
expect(store.findUniqueMinimalClarificationThread(
  group.id,
  service.id,
  "8094907011",
  new Date("2026-08-14T03:32:45+08:00"),
)?.id).toBe(thread.id)
```

再建立第二个同发送人的有效待补充线程，断言结果变成 `null`；将发送人改成另一用户也断言 `null`。

- [ ] **Step 2: 运行临时测试确认 RED**

Run:

```bash
pnpm exec vitest run .tmp-standalone-clarification-routing.test.ts
```

Expected: FAIL，提示 `findUniqueMinimalClarificationThread is not a function`。

- [ ] **Step 3: 实现最小查询**

在 `SupportThreadStore` 中复用 `expiryTimes(reference)` 与 `archiveExpired(reference)`。查询最多返回两个候选，条件固定为：

```sql
t.group_id=?
AND t.service_id=?
AND t.status='answered'
AND t.latest_message_at>?
AND r.thread_id=t.id
AND r.input_revision=t.revision
AND r.sender_user_id=?
AND r.status='replied'
AND r.decision='reply'
AND r.operator_delivery_status='sent'
AND instr(COALESCE(r.decision_reason,''),'strategy=minimal_clarification')>0
```

按 `r.updated_at DESC,r.id DESC` 排序并 `LIMIT 2`。只有结果长度等于 1 时返回 `threadFromRow(rows[0])`，否则返回 `null`。

- [ ] **Step 4: 运行临时测试确认 GREEN**

Run:

```bash
pnpm exec vitest run .tmp-standalone-clarification-routing.test.ts
```

Expected: PASS，唯一候选命中，不同发送人和两个候选均返回 `null`。

---

### Task 2: 在模型路由前确定性续接

**Files:**
- Modify: `src/support/thread-coordinator.ts`
- Update Temporary Test: `.tmp-standalone-clarification-routing.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `findUniqueMinimalClarificationThread(...)`
- Produces: 无显式回复的同发送人裸短答案自动调用现有 `appendMessage(...)` 路径

- [ ] **Step 1: 写协调器失败用例**

使用 `batchWindowMs: 0` 构造协调器，路由 stub 返回 `ignore` 并记录调用次数：

```ts
const route = vi.fn(async () => [{
  action: "ignore" as const,
  targetThreadId: null,
  questionFragment: "kakaxi",
  reason: "孤立短文本",
  confidence: 1,
}])
```

接受与原问题同发送人的消息：

```ts
coordinator.accept({
  groupId: group.id,
  messageId: "3174",
  senderId: "8094907011",
  senderUsername: null,
  senderDisplayName: "OLD WANG",
  fromBot: false,
  replyToMessageId: null,
  messageThreadId: null,
  replyTargetIsBot: false,
  text: "kakaxi",
  attachments: [],
  createdAt: "2026-08-13T19:32:45.000Z",
})
```

等待协调器空闲后断言：事件 `routeStatus` 为 `routed`，`findThreadByEvent(event.id)?.id` 等于原线程，关系为 `reopen`，线程 revision 增加 1，并且 `route` 没有被调用。

- [ ] **Step 2: 运行临时测试确认 RED**

Run:

```bash
pnpm exec vitest run .tmp-standalone-clarification-routing.test.ts
```

Expected: FAIL，事件仍为 `ignored` 或路由 stub 被调用。

- [ ] **Step 3: 实现确定性续接**

在 `routeBatch` 的显式回复处理之后、构建 unresolved reply references 之前，仅当整批事件都没有 `replyToMessageId` 时查询唯一线程。使用批次第一条消息的 `senderUserId`，命中后复用现有 append 逻辑：

```ts
const clarificationTarget = batch.events.every((event) => !event.replyToMessageId)
  ? this.deps.store.findUniqueMinimalClarificationThread(
    batch.group.id,
    batch.service.id,
    batch.events[0]!.senderUserId,
  )
  : null
```

第一条按目标当前状态选择 `reopen` / `supplement`，携带 `expectedRevision`；剩余事件按 `supplement` 追加。成功后调用 `cancelStale`、`wake` 并返回；并发抢占导致第一条 append 失败时继续走现有模型路由，不强行创建或串入旧线程。

- [ ] **Step 4: 补齐边界红绿用例**

临时测试分别断言：

- 不同发送人调用模型路由而不自动续接。
- 两个候选调用模型路由而不自动续接。
- 非 `minimal_clarification`、未发送成功、已关闭或过期线程不自动续接。
- 有 `replyToMessageId` 时仍走现有显式回复路径。

逐个运行并确认新增断言先失败，再以最小条件修正实现，直到全部通过。

- [ ] **Step 5: 运行相关现有测试**

Run:

```bash
pnpm exec vitest run tests/support/human-takeover.test.ts tests/support/raw-message-preservation.test.ts tests/telegram/runtime-learning-source.test.ts
```

Expected: PASS。

---

### Task 3: 规则同步、清理与完整验证

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/agent-playbooks/diagnostics-and-replies.md`
- Delete: `.tmp-standalone-clarification-routing.test.ts`

**Interfaces:**
- Consumes: Task 1 和 Task 2 的最终路由行为
- Produces: 权威规则与运行手册同步，最终 Git 差异不包含测试文件

- [ ] **Step 1: 同步固定规则**

在问题线程规则中明确：机器人以 `minimal_clarification` 追问后，同一发送人的裸短答案在同群同服务只有一个有效候选时直接续接；不同发送人、多个候选、过期或未成功发送追问时不得确定性吸附。

- [ ] **Step 2: 删除临时测试并检查范围**

Run:

使用 `apply_patch` 删除 `.tmp-standalone-clarification-routing.test.ts`，然后运行：

```bash
git diff --name-only | rg '^tests/|^\.tmp-' && exit 1 || true
git diff --check
```

Expected: 无测试文件进入最终差异，`git diff --check` 无输出。

- [ ] **Step 3: 运行全量门禁**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: 全量测试 0 failures，类型检查和服务端/前端生产构建 exit 0。

- [ ] **Step 4: 提交**

```bash
git add AGENTS.md docs/agent-playbooks/diagnostics-and-replies.md \
  src/support/thread-store.ts src/support/thread-coordinator.ts \
  docs/superpowers/plans/2026-08-14-standalone-clarification-answer-routing.md
git commit -m "客服：续接机器人追问后的裸短答案"
```

---

### Task 4: 推送和 Linux 部署验收

**Files:**
- No repository file changes

**Interfaces:**
- Consumes: 已验证并提交的精确 Git revision
- Produces: 远端 `telegram-ai-support` 与健康的 `telegram-codex-support.service`

- [ ] **Step 1: 推送前确认远端没有新提交**

```bash
git fetch origin telegram-ai-support
git rev-list --left-right --count origin/telegram-ai-support...HEAD
```

Expected: 左侧为 `0`；若远端领先则先停止并集成。

- [ ] **Step 2: 推送当前分支**

```bash
git push origin telegram-ai-support
```

- [ ] **Step 3: 在既有 Linux 服务器验证精确提交**

在 `/opt/telegram-codex-support/current` 使用服务账号 fetch 并 checkout 精确提交，运行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

任一门禁失败时不重启服务。

- [ ] **Step 4: 重启与健康检查**

门禁通过后重启 `telegram-codex-support.service`，并验证：

```text
systemctl is-active telegram-codex-support.service = active
GET http://127.0.0.1:3210/health = status ok
ss = 仅监听 127.0.0.1:3210
/api/runtime-status = telegram.running true
当前进程 warning = 0
```

失败时恢复部署前提交、重新构建和重启，业务 SQLite 不替换、不迁移。
