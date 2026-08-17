# 同群角色用户人工接管实施计划

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for every task, `superpowers:verification-before-completion` before reporting completion, and `superpowers:requesting-code-review` after the full suite passes.

**Goal:** 当已启用的角色用户在同一个客服群回复一个仍在等待或生成中的问题时，立即关闭该问题并停止后续 AI 回复；已经进入 Telegram 发送阶段或已经发出的消息不撤回、不删除。

**Architecture:** 将现有“学习来源观察器同时负责人工接管”的实现拆为独立的 `HumanTakeoverService` 和只负责学习的 `LearningSourceObserver`。接管服务只在同一 `group_id + service_id` 内按确定性优先级关联问题，并把关联、线程状态复核、关闭和追加式接管审计放进同一个 SQLite 事务；线程关闭后继续使用现有 `AbortController` 取消生成。学习开关只决定是否从已发生的接管审计派生学习观察，不再决定是否接管。

**Tech Stack:** Node.js 22.16+、TypeScript 5.9、`node:sqlite`、Fastify、Vitest、原生 TypeScript/CSS、SQLite schema v24。

---

## 不可变实施约束

- 只处理 `purpose='support'` 的白名单群；技术告警群不触发人工接管。
- 发送人必须通过已启用角色的 Telegram 数字用户 ID 精确匹配；用户名和群管理员身份不能授权。
- `/ai` 与 `/correct` 继续走现有命令语义，不触发接管。
- 线程关联顺序固定为：直接回复问题消息、直接回复机器人输出、同群回复链、同群同服务唯一活动线程。
- 关联候选只包含 `collecting` 和 `generating`；同群存在多个候选时记录 `ambiguous`，不关闭任何线程。
- 最终写入时必须再次校验目标线程的 `group_id`、`service_id` 和状态，入口层判断不能替代事务内校验。
- `pending`、`queued`、`generating` 回复改为 `superseded`；生成任务通过现有取消端口终止。
- `sending` 只记录 `delivery_in_flight`，不撤回、不重发、不修改 Telegram 所有权；`sent` 完全不处理。
- 已终态线程只记录 `thread_already_terminal`，不改变原终态。
- `learningSourceEnabled=false` 仍然接管；它只阻止创建 `learning_source_observations`。
- 接管审计是追加式证据，默认禁止 UPDATE/DELETE；90 天保留策略后续按客服记录整体清理规则执行，迁移本身不改变现有保留策略。
- 不新增运行依赖，不在本机启动或重启常驻客服服务，不执行部署。

## 文件与接口总览

**新增**

- `src/support/human-takeover-store.ts`：追加式接管审计读写。
- `src/support/human-takeover-service.ts`：角色复核、同群关联与接管编排。
- `tests/runtime/human-takeover-schema.test.ts`：schema v24、约束、导入导出。

**修改**

- `src/runtime/types.ts`：通用接管枚举与 `HumanTakeoverRecord`。
- `src/runtime/database.ts`：schema v24、v23→v24 迁移、结构校验。
- `src/runtime/backup-service.ts`：迁移库复制与验证接管审计。
- `src/support/thread-store.ts`：专用活动候选查询、事务内同群复核。
- `src/support/thread-lifecycle-service.ts`：对象式接管输入和取消调用。
- `src/support/learning-source-observer.ts`：只从接管结果派生学习观察。
- `src/support/thread-coordinator.ts`、`src/server.ts`：先接管、后按开关学习。
- `src/support/thread-query-service.ts`、`web/src/types.ts`、`web/src/learning-source-labels.ts`、`web/src/views/replies.ts`：后台接管审计。
- `web/src/views/accounts-groups.ts`：明确“启用角色会同群接管，学习开关只控制学习”。
- `AGENTS.md`：将本次确认规则写入项目固定行为。
- 相关现有测试：schema 版本、接管竞态、观察器、管理 API 和前端标签。

关键接口最终形态：

```ts
export type HumanTakeoverOutcome = {
  takeover: HumanTakeoverRecord
  role: TelegramRole
  serviceId: string | null
}

export type HumanTakeoverInput = {
  threadId: string
  groupId: string
  serviceId: string
  actor: string
  now: string
}

export interface HumanTakeoverPort {
  observe(event: SupportMessageEvent): HumanTakeoverOutcome | null
}

export interface LearningSourceObservationPort {
  observe(event: SupportMessageEvent, outcome: HumanTakeoverOutcome): LearningSourceObservation | null
}
```

## Task 1：先用失败测试锁定 schema v24 与追加式审计

**Files:**

- Create: `tests/runtime/human-takeover-schema.test.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/database.ts`
- Modify: `src/runtime/backup-service.ts`
- Modify: `tests/runtime/telegram-output-ownership-schema.test.ts`
- Modify: `tests/runtime/reference-learning-schema.test.ts`
- Modify: `tests/runtime/learning-source-schema.test.ts`
- Modify: `tests/runtime/integration-model-schema.test.ts`
- Modify: `tests/replies/retention-learning-observation.test.ts`

### Step 1：写 schema 失败测试

测试必须覆盖：新库版本为 24、v23 原位迁移、唯一消息事件、群/线程外键、合法枚举、追加式 UPDATE/DELETE 阻断。

```ts
it("创建追加式人工接管审计并迁移到 schema 24", async () => {
  const database = await RuntimeDatabase.open(filePath)
  expect(database.schemaVersion()).toBe(24)
  expect(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='support_human_takeovers'",
  ).get()).toBeTruthy()

  const record = seedHumanTakeover(database, {
    associationReason: "single_active_thread",
    takeoverStatus: "cancelled",
  })
  expect(() => database.prepare(
    "UPDATE support_human_takeovers SET takeover_status='not_linked' WHERE id=?",
  ).run(record.id)).toThrow(/append only/i)
  expect(() => database.prepare(
    "DELETE FROM support_human_takeovers WHERE id=?",
  ).run(record.id)).toThrow(/append only/i)
})
```

再加一条结构篡改测试，删除索引或替换触发器后打开 v24 数据库必须抛出“人工接管审计结构不完整”，证明不是只看版本号。

### Step 2：运行测试并确认红灯

Run:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm test tests/runtime/human-takeover-schema.test.ts
```

Expected: FAIL，原因是 schema 仍为 23 且表不存在。

### Step 3：在运行时类型中新增通用接管记录

在 `src/runtime/types.ts` 中让学习观察和人工接管共用枚举，避免两套字符串漂移：

```ts
export const humanTakeoverAssociationReasonSchema = z.enum([
  "direct_question",
  "direct_bot_reply",
  "reply_chain",
  "single_active_thread",
  "ambiguous",
  "none",
])

export const humanTakeoverStatusSchema = z.enum([
  "cancelled",
  "delivery_in_flight",
  "thread_already_terminal",
  "ambiguous",
  "not_linked",
])

export const learningAssociationReasonSchema = humanTakeoverAssociationReasonSchema
export const learningTakeoverStatusSchema = humanTakeoverStatusSchema

export const humanTakeoverRecordSchema = z.object({
  id: z.string().uuid(),
  messageEventId: z.string().uuid(),
  groupId: z.string().uuid(),
  threadId: z.string().uuid().nullable(),
  sourceTelegramUserId: z.string().regex(/^\d+$/u),
  sourceRole: z.enum(["operator", "technical", "reviewer", "ignored"]),
  associationReason: humanTakeoverAssociationReasonSchema,
  associationConfidence: z.number().min(0).max(1),
  takeoverStatus: humanTakeoverStatusSchema,
  createdAt: z.string().datetime(),
}).strict()

export type HumanTakeoverRecord = z.infer<typeof humanTakeoverRecordSchema>
```

### Step 4：新增 schema 与 v23→v24 迁移

在 `src/runtime/database.ts` 定义并复用同一份表结构：

```sql
CREATE TABLE IF NOT EXISTS support_human_takeovers (
  id TEXT PRIMARY KEY,
  message_event_id TEXT NOT NULL UNIQUE REFERENCES support_message_events(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES support_threads(id) ON DELETE SET NULL,
  source_telegram_user_id TEXT NOT NULL CHECK (
    length(source_telegram_user_id)>0 AND source_telegram_user_id NOT GLOB '*[^0-9]*'
  ),
  source_role TEXT NOT NULL CHECK (source_role IN ('operator','technical','reviewer','ignored')),
  association_reason TEXT NOT NULL CHECK (
    association_reason IN ('direct_question','direct_bot_reply','reply_chain','single_active_thread','ambiguous','none')
  ),
  association_confidence REAL NOT NULL CHECK (association_confidence BETWEEN 0 AND 1),
  takeover_status TEXT NOT NULL CHECK (
    takeover_status IN ('cancelled','delivery_in_flight','thread_already_terminal','ambiguous','not_linked')
  ),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS support_human_takeovers_thread_idx
  ON support_human_takeovers(thread_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS support_human_takeovers_group_idx
  ON support_human_takeovers(group_id,created_at DESC,id DESC);
CREATE TRIGGER IF NOT EXISTS support_human_takeovers_no_update
BEFORE UPDATE ON support_human_takeovers
WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
BEGIN SELECT RAISE(ABORT, 'support human takeovers are append only'); END;
CREATE TRIGGER IF NOT EXISTS support_human_takeovers_no_delete
BEFORE DELETE ON support_human_takeovers
WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
BEGIN SELECT RAISE(ABORT, 'support human takeovers are append only'); END;
```

实现：

```ts
function migrateV23ToV24(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    connection.exec(humanTakeoversSchema)
    connection.prepare("UPDATE metadata SET value='24' WHERE key='schema_version'").run()
    connection.exec("COMMIT")
  } catch (error) {
    connection.exec("ROLLBACK")
    throw error
  }
}
```

运行库和可写迁移库的升级链都加入 `23 -> 24`，新库 schema version 改为 24；对原本就是 v24 的数据库调用 `assertHumanTakeoverAuditStructure`，并在最终 schema 初始化后再次调用。

### Step 5：补齐迁移库导出、导入和验证

在 `src/runtime/backup-service.ts`：

- 将 `support_human_takeovers` 加入 `portableTables` 和 `sensitiveScanTables`。
- 接受 schema 24；v23 迁移库允许没有新表，v24 必须存在。
- 复制顺序放在 `support_message_events` 和 `support_threads` 之后，保证外键目标已经导入。
- 复制列固定为：

```ts
copy("support_human_takeovers", `id,message_event_id,group_id,thread_id,source_telegram_user_id,
  source_role,association_reason,association_confidence,takeover_status,created_at`)
```

- 验证 `message_event_id` 对应事件的 `group_id` 等于审计 `group_id`；`thread_id` 非空时线程也必须同群。
- 导入后使用 `humanTakeoverRecordSchema` 逐行校验，拒绝伪造枚举、越界置信度和跨群引用。

### Step 6：更新所有“当前版本 23”断言

只把“迁移完成后的当前版本”改为 24；构造 v21/v22/v23 谱系的 fixture 版本号保持原值，确保旧迁移路径仍被覆盖。

### Step 7：运行 schema 与导入导出测试

Run:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm test \
  tests/runtime/human-takeover-schema.test.ts \
  tests/runtime/learning-source-schema.test.ts \
  tests/runtime/telegram-output-ownership-schema.test.ts \
  tests/runtime/reference-learning-schema.test.ts \
  tests/runtime/integration-model-schema.test.ts \
  tests/replies/retention-learning-observation.test.ts
```

Expected: PASS。

### Step 8：提交

```bash
git add src/runtime/types.ts src/runtime/database.ts src/runtime/backup-service.ts tests/runtime tests/replies/retention-learning-observation.test.ts
git commit -m "数据库：新增人工接管审计"
```

## Task 2：以失败测试实现同群关联服务

**Files:**

- Create: `src/support/human-takeover-store.ts`
- Create: `src/support/human-takeover-service.ts`
- Modify: `src/support/thread-store.ts`
- Modify: `src/support/thread-lifecycle-service.ts`
- Modify: `tests/support/learning-source-observer.test.ts`
- Modify: `tests/support/human-takeover.test.ts`

### Step 1：先改测试夹具为“接管”和“学习”两个端口

测试夹具分别暴露：

```ts
const takeovers = new HumanTakeoverStore(database)
const takeoverService = new HumanTakeoverService({
  database,
  threads,
  takeovers,
  legacyObservations: observations,
  materializePendingBatch: (eventId) => coordinator.materializePendingBatchForEvent(eventId),
  lifecycle,
})
```

新增下列失败测试：

1. 已启用且 `learningSourceEnabled=false` 的角色直接回复同群问题会关闭线程。
2. 用户名相同但数字 ID 不同不接管。
3. 已停用角色不接管。
4. 技术告警群不接管。
5. `/ai` 和 `/correct` 不接管。
6. 直接回复另一个群的 Telegram message ID 不关联。
7. 回复链只能在同群最多向上 32 层。
8. 同群同服务唯一活动线程可接管。
9. 同群有两个活动线程时记录 `ambiguous` 且两者都保持活动。
10. 同群已终态线程记录 `thread_already_terminal`。

关键断言：

```ts
expect(threads.getThread(thread.id).status).toBe("closed")
expect(takeovers.findByMessageEvent(event.id)).toEqual(expect.objectContaining({
  groupId: group.id,
  threadId: thread.id,
  associationReason: "direct_question",
  takeoverStatus: "cancelled",
}))
expect(database.prepare(
  "SELECT COUNT(*) AS count FROM learning_source_observations WHERE message_event_id=?",
).get(event.id)).toEqual({ count: 0 })
```

### Step 2：运行测试并确认红灯

Run:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm test tests/support/learning-source-observer.test.ts tests/support/human-takeover.test.ts
```

Expected: FAIL，非学习角色不会触发现有观察器，且独立接管类尚不存在。

### Step 3：实现追加式 `HumanTakeoverStore`

在 `src/support/human-takeover-store.ts`：

```ts
export type HumanTakeoverRecordInput = Omit<HumanTakeoverRecord, "id" | "createdAt">

export class HumanTakeoverStore {
  constructor(private readonly database: RuntimeDatabase) {}

  findByMessageEvent(messageEventId: string): HumanTakeoverRecord | null {
    const row = this.database.prepare(
      "SELECT * FROM support_human_takeovers WHERE message_event_id=?",
    ).get(messageEventId) as SqlRow | undefined
    return row ? humanTakeoverFromRow(row) : null
  }

  record(input: HumanTakeoverRecordInput, createdAt = new Date().toISOString()): HumanTakeoverRecord {
    const existing = this.findByMessageEvent(input.messageEventId)
    if (existing) return existing
    const id = randomUUID()
    this.database.prepare(`INSERT INTO support_human_takeovers(
      id,message_event_id,group_id,thread_id,source_telegram_user_id,source_role,
      association_reason,association_confidence,takeover_status,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.messageEventId, input.groupId, input.threadId,
      input.sourceTelegramUserId, input.sourceRole, input.associationReason,
      input.associationConfidence, input.takeoverStatus, createdAt,
    )
    return this.findByMessageEvent(input.messageEventId)!
  }
}
```

`humanTakeoverFromRow` 必须通过 `humanTakeoverRecordSchema.parse`，不手写未校验对象。

### Step 4：增加专用活动线程候选查询

不要复用可能包含已回答线程的 `listRouteCandidates`。在 `SupportThreadStore` 新增：

```ts
listHumanTakeoverCandidates(
  groupId: string,
  serviceId: string,
  limit = 2,
  reference = new Date().toISOString(),
): SupportThread[] {
  const { cutoff } = expiryTimes(reference)
  return (this.database.prepare(`SELECT * FROM support_threads
    WHERE group_id=? AND service_id=?
      AND status IN ('collecting','generating')
      AND latest_message_at>?
    ORDER BY latest_message_at DESC,id DESC
    LIMIT ?`).all(groupId, serviceId, cutoff, limit) as SqlRow[]).map(threadFromRow)
}
```

### Step 5：实现确定性关联服务

`HumanTakeoverService.observe` 的入口顺序必须固定：

```ts
observe(event: SupportMessageEvent): HumanTakeoverOutcome | null {
  const group = this.deps.database.readGroups().find((candidate) => candidate.id === event.groupId)
  if (!group?.enabled || group.purpose !== "support" || !group.serviceId) return null
  if (event.routeStatus !== "role_skipped") return null

  const role = this.deps.database.readRoles().find((candidate) => (
    candidate.enabled
    && /^\d+$/u.test(event.senderUserId)
    && candidate.telegramUserId === event.senderUserId
  ))
  if (!role) return null

  const existing = this.deps.takeovers.findByMessageEvent(event.id)
  if (existing) return { takeover: existing, role, serviceId: group.serviceId }

  const association = this.associate(event, group.serviceId)
  if (association.reason === "ambiguous") {
    return {
      takeover: this.record(event, group.id, role, association, "ambiguous"),
      role,
      serviceId: group.serviceId,
    }
  }
  if (!association.thread) {
    return {
      takeover: this.record(event, group.id, role, association, "not_linked"),
      role,
      serviceId: group.serviceId,
    }
  }
  return this.deps.lifecycle.takeOverFromHuman({
    threadId: association.thread.id,
    groupId: group.id,
    serviceId: group.serviceId,
    actor: role.displayName || role.username || role.telegramUserId,
    now: event.createdAt,
  }, (status) => ({
    takeover: this.record(event, group.id, role, association, status),
    role,
    serviceId: group.serviceId,
  }))
}
```

`associate` 保留既有优先级；每次找到线程都调用共同守卫：

```ts
private sameScope(thread: SupportThread, groupId: string, serviceId: string): boolean {
  return thread.groupId === groupId && thread.serviceId === serviceId
}
```

回复链先查 `support_human_takeovers`，再查旧的 `learning_source_observations`，从而让升级前已经建立的人工回复链继续可追溯；任何一个历史记录的线程不在当前群和当前服务时直接忽略。

### Step 6：在事务内再次校验同群和状态

把 `SupportThreadStore.takeOverByHuman` 改成对象输入：

```ts
takeOverByHuman<T>(
  input: HumanTakeoverInput,
  complete: (result: HumanTakeoverResult) => T,
): { takeover: HumanTakeoverResult; value: T }
```

事务开头：

```ts
const current = this.getThread(input.threadId)
if (current.groupId !== input.groupId || current.serviceId !== input.serviceId) {
  const takeover = {
    changed: false,
    thread: current,
    replyUpdates: [],
    takeoverStatus: "not_linked" as const,
  }
  return { takeover, value: complete(takeover) }
}
```

之后保持现有终态检测和 `delivery_in_flight` 查询；关闭原因改为 `角色用户回复后人工接管`。`complete` 仍在同一个数据库事务内执行，以保证线程关闭和审计写入原子提交。

### Step 7：保留事务提交后取消生成

`SupportThreadLifecycleService` 使用：

```ts
takeOverFromHuman<T>(input: HumanTakeoverInput, complete: (status: HumanTakeoverStatus) => T): T {
  const result = this.store.takeOverByHuman(
    input,
    (takeover) => complete(takeover.takeoverStatus),
  )
  if (result.takeover.changed) this.cancellation.cancel(input.threadId)
  return result.value
}
```

只有事务成功提交后调用取消端口；若审计 INSERT 失败，事务回滚且不得取消生成。

### Step 8：运行并提交

Run:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm test tests/support/learning-source-observer.test.ts tests/support/human-takeover.test.ts
```

Expected: PASS。

```bash
git add src/support/human-takeover-store.ts src/support/human-takeover-service.ts \
  src/support/thread-store.ts src/support/thread-lifecycle-service.ts \
  tests/support/learning-source-observer.test.ts tests/support/human-takeover.test.ts
git commit -m "客服：实现同群角色用户人工接管"
```

## Task 3：解耦学习开关并接入消息入口

**Files:**

- Modify: `src/support/learning-source-observer.ts`
- Modify: `src/support/thread-coordinator.ts`
- Modify: `src/server.ts`
- Modify: `tests/support/learning-source-observer.test.ts`
- Modify: `tests/support/human-takeover.test.ts`

### Step 1：先写入口级失败测试

覆盖以下矩阵：

| 角色状态 | 学习来源 | 同群活动线程 | 接管审计 | 学习观察 |
|---|---:|---:|---:|---:|
| 启用 | 关 | 有 | 有 | 无 |
| 启用 | 开 | 有 | 有 | 有 |
| 停用 | 任意 | 有 | 无 | 无 |
| 启用 | 任意 | 无 | `not_linked` | 仅学习开启时有 |

再加入幂等测试：相同 Telegram 消息重复接收只能有一条接管审计和至多一条学习观察。

### Step 2：确认现有代码红灯

Run:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm test tests/support/learning-source-observer.test.ts
```

Expected: FAIL，现有 coordinator 只调用学习观察器。

### Step 3：把 `LearningSourceObserver` 缩成派生器

移除它对 database、thread store、materialize 和 lifecycle 的依赖，只保留 observation store：

```ts
export class LearningSourceObserver {
  constructor(private readonly observations: LearningSourceStore) {}

  observe(event: SupportMessageEvent, outcome: HumanTakeoverOutcome): LearningSourceObservation | null {
    if (!outcome.role.learningSourceEnabled) return null
    const existing = this.observations.findByMessageEvent(event.id)
    if (existing) return existing
    const takeover = outcome.takeover
    return this.observations.record({
      messageEventId: event.id,
      sourceTelegramUserId: takeover.sourceTelegramUserId,
      sourceRole: takeover.sourceRole,
      threadId: takeover.threadId,
      serviceId: outcome.serviceId,
      associationReason: takeover.associationReason,
      associationConfidence: takeover.associationConfidence,
      takeoverStatus: takeover.takeoverStatus,
      classification: "reference_reply",
      risk: "low",
      processingStatus: ["ambiguous", "none"].includes(takeover.associationReason) ? "ignored" : "pending",
    })
  }
}
```

`serviceId` 由接管服务写入 `HumanTakeoverOutcome`，学习器直接使用 `outcome.serviceId`，不重新执行线程关联或服务查询。

### Step 4：coordinator 固定为先接管、后学习

依赖新增：

```ts
humanTakeoverService?: Pick<HumanTakeoverService, "observe">
learningSourceObserver?: Pick<LearningSourceObserver, "observe">
```

角色消息分支：

```ts
if (recorded.event.routeStatus === "role_skipped") {
  const outcome = this.deps.humanTakeoverService?.observe(recorded.event)
  if (outcome) this.deps.learningSourceObserver?.observe(recorded.event, outcome)
}
```

保持随后 `route.action === "ignore"` 立即返回，角色消息不能进入问题批次，也不能延长原线程等待时间。

### Step 5：server wiring

按以下顺序实例化，避免闭包在 `supportThreadCoordinator` 赋值前被同步调用：

```ts
const humanTakeoverStore = new HumanTakeoverStore(runtimeDatabase)
const learningSourceStore = new LearningSourceStore(runtimeDatabase)
const humanTakeoverService = new HumanTakeoverService({
  database: runtimeDatabase,
  threads: supportThreadStore,
  takeovers: humanTakeoverStore,
  legacyObservations: learningSourceStore,
  materializePendingBatch: (eventId) => supportThreadCoordinator.materializePendingBatchForEvent(eventId),
  lifecycle: supportThreadLifecycleService,
})
const learningSourceObserver = new LearningSourceObserver(learningSourceStore)
```

然后同时注入 coordinator。

### Step 6：锁定发送边界和并发行为

在 `tests/support/human-takeover.test.ts` 保留并强化：

- `pending/queued/generating` 变 `superseded`，线程 `closed`，取消端口收到 thread ID。
- 已有 `support_replies.status='sending'`、发送中告警、发送中通知或 `telegram_output_ownership.delivery_status='sending'` 时审计为 `delivery_in_flight`。
- `sent` 回复内容和 Telegram message ID 不变，不调用删除接口。
- 接管与 worker 最终 CAS 同时发生时，最多一方提交可发送终态；关闭后 worker 结果为 `superseded`。
- 接管审计写入失败时线程关闭回滚且不 cancel。
- 学习观察写入失败时接管仍然提交，因为学习发生在接管事务之后。

### Step 7：运行并提交

```bash
PATH=/opt/homebrew/bin:$PATH pnpm test tests/support/learning-source-observer.test.ts tests/support/human-takeover.test.ts
PATH=/opt/homebrew/bin:$PATH pnpm typecheck
```

Expected: PASS。

```bash
git add src/support/learning-source-observer.ts src/support/thread-coordinator.ts src/server.ts \
  tests/support/learning-source-observer.test.ts tests/support/human-takeover.test.ts
git commit -m "客服：解耦人工接管与学习来源"
```

## Task 4：后台展示接管审计并修正文案

**Files:**

- Modify: `src/support/thread-query-service.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/learning-source-labels.ts`
- Modify: `web/src/views/replies.ts`
- Modify: `web/src/views/accounts-groups.ts`
- Modify: `web/styles.css`
- Modify: `tests/routes/admin-api.test.ts`
- Modify: `tests/app.test.ts`

### Step 1：先写 API 和前端失败测试

管理 API 测试插入一条没有学习观察的接管审计，并断言详情仍可见：

```ts
expect(detail.json().humanTakeovers).toEqual([
  expect.objectContaining({
    sourceTelegramUserId: "10001",
    associationReason: "direct_question",
    takeoverStatus: "cancelled",
  }),
])
expect(detail.json().learningObservations).toEqual([])
```

前端纯函数测试：

```ts
expect(roleHumanTakeoverLabel(role)).toBe("启用后同群回复会人工接管 · ID 10001")
expect(roleLearningSourceLabel({ ...role, learningSourceEnabled: false }))
  .toBe("不作为学习来源")
expect(humanTakeoverFacts(takeover)).toContainEqual(["接管状态", "已接管"])
```

### Step 2：运行测试并确认红灯

```bash
PATH=/opt/homebrew/bin:$PATH pnpm test tests/routes/admin-api.test.ts tests/app.test.ts
```

Expected: FAIL，详情尚无 `humanTakeovers`。

### Step 3：扩展详情 API

在 `thread-query-service.ts` 新增 `HumanTakeoverAudit`，并使用 `humanTakeoverRecordSchema.pick(...)` 校验。`getDetail` 查询：

```sql
SELECT id,message_event_id,group_id,thread_id,source_telegram_user_id,source_role,
  association_reason,association_confidence,takeover_status,created_at
FROM support_human_takeovers
WHERE thread_id=?
ORDER BY created_at,id
```

返回对象加入 `humanTakeovers`，保留原 `learningObservations`，不再用学习观察代替接管事实。

### Step 4：扩展 web 类型与时间线

`web/src/types.ts`：

```ts
export type HumanTakeoverAudit = {
  id: string
  messageEventId: string
  groupId: string
  threadId: string | null
  sourceTelegramUserId: string
  sourceRole: "operator" | "technical" | "reviewer" | "ignored"
  associationReason: LearningObservationAudit["associationReason"]
  associationConfidence: number
  takeoverStatus: LearningObservationAudit["takeoverStatus"]
  createdAt: string
}
```

`SupportThreadDetail` 加 `humanTakeovers: HumanTakeoverAudit[]`。

在标签模块导出 `humanTakeoverFacts`；`delivery_in_flight` 文案改成“发送已开始 不撤回”，避免“发送中未知”让管理员误以为系统还会删除。

时间线新增“人工接管”卡片，展示角色、数字 ID、关联方式、置信度和接管状态；学习卡继续独立显示。两者按 `createdAt` 排序，不合并为一张卡。

### Step 5：修正角色配置文案

角色弹窗说明固定加入：

```text
已启用用户在同群回复客服问题时会接管并停止 AI 处理
学习来源只控制是否用于 AI 学习
```

角色列表描述由学习标签单独占据改为：

```ts
`${roleHumanTakeoverLabel(role)} · ${roleLearningSourceLabel(role)} · ${usernameLabel}`
```

停用角色显示“停用时不会人工接管”；学习 badge 保持现状。新增样式只处理帮助文案间距和接管卡的颜色，不改变页面布局结构。

### Step 6：运行前端与 API 测试

```bash
PATH=/opt/homebrew/bin:$PATH pnpm test tests/routes/admin-api.test.ts tests/app.test.ts
PATH=/opt/homebrew/bin:$PATH pnpm typecheck
PATH=/opt/homebrew/bin:$PATH pnpm build:web
```

Expected: PASS。

### Step 7：真实页面验证浅色、深色与窄屏

使用现有本地开发入口打开“群与账号 > 用户与角色”和“客服记录 > 线程详情”，分别验证：

- 1440px 浅色：标签和帮助文案不挤压操作按钮。
- 1440px 深色：接管卡、badge 和次要文字对比度可读。
- 390px：角色列表无横向溢出，线程详情抽屉可滚动，接管卡字段不截断。

只运行临时开发进程做页面验证，验证结束立即停止；不要安装或启动常驻服务。

### Step 8：提交

```bash
git add src/support/thread-query-service.ts web/src/types.ts web/src/learning-source-labels.ts \
  web/src/views/replies.ts web/src/views/accounts-groups.ts web/styles.css \
  tests/routes/admin-api.test.ts tests/app.test.ts
git commit -m "后台：展示人工接管记录"
```

## Task 5：固化项目规则并做全量回归

**Files:**

- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-08-13-same-group-human-takeover-design.md`（仅在实现细节与已确认设计存在必要差异时更新）

### Step 1：把确认行为写入固定规则

在 `AGENTS.md` 的“客服消息按问题线程处理”附近加入：

```text
- 已启用的后台角色用户在同一个客服群回复仍处于等待或生成中的问题时视为人工接管 系统必须立即关闭该问题并停止后续 AI 生成和发送 关联必须同时匹配群和服务 同群存在多个活动问题且无法唯一关联时不得关闭任何问题 学习来源开关只控制是否产生学习证据 不控制人工接管 已进入 Telegram 发送阶段或已经发出的消息不删除不撤回
```

### Step 2：运行针对性回归

```bash
PATH=/opt/homebrew/bin:$PATH pnpm test \
  tests/support/learning-source-observer.test.ts \
  tests/support/human-takeover.test.ts \
  tests/runtime/human-takeover-schema.test.ts \
  tests/routes/admin-api.test.ts \
  tests/app.test.ts
```

Expected: PASS，输出中无 skipped 或 unhandled rejection。

### Step 3：运行全量验证

```bash
PATH=/opt/homebrew/bin:$PATH node --version
PATH=/opt/homebrew/bin:$PATH pnpm typecheck
PATH=/opt/homebrew/bin:$PATH pnpm test
PATH=/opt/homebrew/bin:$PATH pnpm build
git diff --check
git status --short
```

Expected:

- Node 版本不低于 22.16.0。
- typecheck、全量测试和 build 全部退出码 0。
- `git diff --check` 无输出。
- `git status --short` 只包含本计划范围内的已知改动；不得覆盖用户的无关改动。

### Step 4：执行代码审查

使用 `superpowers:requesting-code-review`，审查重点固定为：

- 是否存在跨群或跨服务关闭路径。
- 是否仍有 `learningSourceEnabled` 决定接管的残留条件。
- 发送中或已发送消息是否可能被修改、重发或删除。
- 关联结果与线程关闭是否真正同事务。
- 重复 update、恢复重放和 worker CAS 是否幂等。
- schema v24 的运行库与迁移库是否验证同一结构。

修复审查发现后重新执行 Step 2 和 Step 3。

### Step 5：提交固定规则和审查修复

```bash
git add AGENTS.md docs/superpowers/specs/2026-08-13-same-group-human-takeover-design.md
git commit -m "规则：固化同群人工接管边界"
```

如果设计文档没有变化，只提交 `AGENTS.md`。审查修复应与对应模块一同提交，不能把测试红灯留到此提交。

## 完成定义

- 非学习来源的已启用角色在同群回复仍能立即接管。
- 跨群、跨服务、停用角色、用户名冒用、技术告警群、`/ai`、`/correct` 均不能接管。
- 关联歧义时不关闭线程，并有独立审计。
- 等待、排队、生成中的回复停止；发送中和已发送消息不删除、不撤回。
- 接管与审计原子提交，生成取消发生在提交之后。
- 学习失败不能反向撤销已经成功的人工接管。
- 后台独立展示接管事实与学习结果，角色配置文案不再暗示二者是同一开关。
- schema v23 运行库和迁移库都可无损升级到 v24。
- 全量类型检查、测试、构建和页面三种视口验证通过。

## 计划自检

- 需求覆盖：同群、同服务、角色身份、关联优先级、歧义、处理中状态、发送边界、学习解耦、后台审计均有对应实现和测试。
- 竞态覆盖：最终事务复核、审计原子写入、提交后 cancel、worker CAS、发送所有权均有明确测试。
- 迁移覆盖：运行库、可写迁移库、导出、导入、结构篡改和旧版本谱系均有明确步骤。
- 类型一致：`HumanTakeoverRecord` 使用同一套 Zod 枚举贯穿 store、service、API 和 web；学习观察复用枚举但保留独立记录。
- 无占位符：所有步骤均给出具体文件、接口、命令、状态和文案，没有 TODO/TBD 或未决设计选择。
- 范围控制：不删除 Telegram 消息、不部署、不新增依赖、不改变技术告警群和命令行为。
