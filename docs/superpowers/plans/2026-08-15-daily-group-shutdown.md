# Daily Group Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在后台配置上海时区的每日关闭时间，到点幂等停用 SQLite 中全部 Telegram 群，并部署到既有 Linux systemd 服务。

**Architecture:** 新增 SQLite 单行调度表保存配置和最近成功运行状态，`DailyGroupShutdownWorker` 启动即检查并每分钟轮询一次。现有运行配置 API 聚合调度数据，前端在“运行配置”维护开关和时间；关闭动作和运行态更新在同一 SQLite 事务中提交。

**Tech Stack:** Node.js 22、TypeScript 5.9、Fastify 5、SQLite、Zod 4、原生 TypeScript/CSS、Vitest 3、systemd。

## Global Constraints

- 项目固定维护路径为 `/Users/oldwang/Desktop/project/sfzf-telegram-ai-support`。
- 关闭范围是 `telegram_groups` 全部记录，包括客服群和技术告警群。
- 调度时区固定为 `Asia/Shanghai`，配置格式固定为 `HH:mm`。
- 当天错过时间后恢复立即补执行，同一关闭时间计划在同一本地日期最多成功一次；修改关闭时间时清空旧计划的当天执行日期。
- 不自动重新启用群，不停用 Telegram 账号，不修改全局 Telegram 监听开关。
- 不新增 Redis、cron 包、外置调度器或 systemd timer。
- 本机只编辑和测试；上线与健康检查仅在既有 Linux systemd 部署目标执行。

---

### Task 1: 持久化调度配置与运行配置 API

**Files:**
- Create: `tests/runtime/daily-group-shutdown-schema.test.ts`
- Modify: `src/version.ts`
- Modify: `src/runtime/database.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/model-config-service.ts`
- Modify: `src/runtime/backup-service.ts`
- Modify: `web/src/types.ts`

**Interfaces:**
- Produces: `DailyGroupShutdownScheduleRecord`，字段为 `enabled`、`time`、`timezone`、`lastRunLocalDate`、`lastRunAt`、`lastDisabledCount`、`updatedAt`。
- Produces: `ModelConfigService.getSettings()` 聚合出的 `dailyGroupShutdown*` 字段。
- Produces: `ModelConfigService.updateSettings()` 仅接受 `dailyGroupShutdownEnabled` 和 `dailyGroupShutdownTime` 两个调度写字段。

- [ ] **Step 1: 写 schema 与 API 失败测试**

```ts
it("把 v25 运行库升级为默认停用的每日全群关闭计划", async () => {
  const database = await RuntimeDatabase.open(legacyV25Path)
  expect(database.schemaVersion()).toBe(26)
  expect(database.prepare("SELECT * FROM daily_group_shutdown_schedule WHERE id=1").get()).toMatchObject({
    enabled: 0, local_time: "23:00", timezone: "Asia/Shanghai",
    last_run_local_date: null, last_run_at: null, last_disabled_count: 0,
  })
})

it("只允许更新每日关闭开关和合法时间", () => {
  expect(service.updateSettings({ dailyGroupShutdownEnabled: true, dailyGroupShutdownTime: "22:35" }))
    .toMatchObject({ dailyGroupShutdownEnabled: true, dailyGroupShutdownTime: "22:35", dailyGroupShutdownTimezone: "Asia/Shanghai" })
  expect(() => service.updateSettings({ dailyGroupShutdownTime: "24:00" })).toThrow()
  expect(() => service.updateSettings({ dailyGroupShutdownLastRunAt: new Date().toISOString() })).toThrow()
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm vitest run tests/runtime/daily-group-shutdown-schema.test.ts`

Expected: FAIL，原因是 schema 仍为 25、调度表及运行配置字段不存在。

- [ ] **Step 3: 实现 v26 表、迁移和严格类型**

在 `src/version.ts` 把 `DATABASE_SCHEMA_VERSION` 升为 `26`。在基础 schema 和 `migrateV25ToV26()` 中创建：

```sql
CREATE TABLE IF NOT EXISTS daily_group_shutdown_schedule (
  id INTEGER PRIMARY KEY CHECK (id=1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  local_time TEXT NOT NULL CHECK (
    length(local_time)=5 AND substr(local_time,3,1)=':'
    AND CAST(substr(local_time,1,2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(local_time,4,2) AS INTEGER) BETWEEN 0 AND 59
  ),
  timezone TEXT NOT NULL CHECK (timezone='Asia/Shanghai'),
  last_run_local_date TEXT,
  last_run_at TEXT,
  last_disabled_count INTEGER NOT NULL DEFAULT 0 CHECK (last_disabled_count>=0),
  updated_at TEXT NOT NULL
);
```

插入默认行 `enabled=0, local_time='23:00', timezone='Asia/Shanghai'`，v25→v26 迁移在事务内完成并更新 metadata。`RuntimeDatabase.open()` 与 `openPortable()` 都串接该迁移。

在 `src/runtime/types.ts` 新增严格 schema，并把 `runtimeSettingsRecordSchema` 扩展为：

```ts
dailyGroupShutdownEnabled: z.boolean(),
dailyGroupShutdownTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
dailyGroupShutdownTimezone: z.literal("Asia/Shanghai"),
dailyGroupShutdownLastRunAt: z.string().datetime().nullable(),
dailyGroupShutdownLastDisabledCount: z.number().int().min(0),
```

- [ ] **Step 4: 聚合和更新运行配置**

`getSettings()` 读取 `runtime_settings` 与单行计划；`settingsUpdateSchema` 加入两个可写字段。`updateSettings()` 使用事务分别更新现有设置与计划，服务端保持 timezone 和最近运行字段不可写。

- [ ] **Step 5: 纳入 SQLite 导入导出**

把 `daily_group_shutdown_schedule` 加入 portable/sensitive scan 表清单。导入时复制唯一计划行；旧版本 portable 经 v26 迁移后已有默认行。验证兼容版本列表加入 26，清库顺序包含该表且不改变账号凭据排除规则。

- [ ] **Step 6: 运行测试并确认 GREEN**

Run: `pnpm vitest run tests/runtime/daily-group-shutdown-schema.test.ts`

Expected: PASS。

Run: `pnpm vitest run tests/runtime/integration-model-schema.test.ts tests/runtime/reference-learning-schema.test.ts tests/routes/admin-api.test.ts`

Expected: PASS，现有迁移和运行配置接口无回归。

### Task 2: 每日到期执行 worker

**Files:**
- Create: `src/runtime/daily-group-shutdown-worker.ts`
- Create: `tests/runtime/daily-group-shutdown-worker.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Produces: `DailyGroupShutdownWorker.runDue(now?: Date): { executed: boolean; disabledCount: number }`。
- Produces: `start()` 启动即检查并每 60 秒检查；`stop()` 清理定时器。
- Consumes: Task 1 的 `daily_group_shutdown_schedule` 单行记录。

- [ ] **Step 1: 写执行语义失败测试**

```ts
it("到点后原子停用客服群和技术告警群", () => {
  enableSchedule(database, "23:00")
  enableAllGroups(database)
  const result = worker.runDue(new Date("2026-08-15T15:00:10.000Z"))
  expect(result).toEqual({ executed: true, disabledCount: 3 })
  expect(database.prepare("SELECT DISTINCT enabled FROM telegram_groups").all()).toEqual([{ enabled: 0 }])
})

it("到点前不执行且同一上海日期只执行一次", () => {
  expect(worker.runDue(new Date("2026-08-15T14:59:59.000Z")).executed).toBe(false)
  expect(worker.runDue(new Date("2026-08-15T15:00:00.000Z")).executed).toBe(true)
  enableOneGroup(database)
  expect(worker.runDue(new Date("2026-08-15T16:00:00.000Z"))).toEqual({ executed: false, disabledCount: 0 })
})

it("当天晚启动补执行，次日到点可以再次执行", () => {
  expect(worker.runDue(new Date("2026-08-15T16:30:00.000Z")).executed).toBe(true)
  enableOneGroup(database)
  expect(worker.runDue(new Date("2026-08-16T15:00:00.000Z"))).toEqual({ executed: true, disabledCount: 1 })
})
```

另写测试覆盖计划关闭、上海午夜日期边界和零个启用群仍记录当日成功。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm vitest run tests/runtime/daily-group-shutdown-worker.test.ts`

Expected: FAIL，原因是 worker 模块不存在。

- [ ] **Step 3: 实现最小 worker**

使用固定 `Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year, month, day, hour, minute, hourCycle: "h23" })` 生成 `YYYY-MM-DD` 和 `HH:mm`。`runDue()` 先快速判断，再在 `database.transaction()` 内重新读取计划：

```ts
const result = database.prepare(
  "UPDATE telegram_groups SET enabled=0,updated_at=? WHERE enabled=1",
).run(now.toISOString())
database.prepare(`UPDATE daily_group_shutdown_schedule
  SET last_run_local_date=?,last_run_at=?,last_disabled_count=?,updated_at=? WHERE id=1`).run(
  localDate, now.toISOString(), Number(result.changes), now.toISOString(),
)
```

事务重检确保配置变更和重复唤醒不会导致同日二次执行。`start()` 的立即检查捕获并记录错误但不抛出、不发送 Telegram 消息；timer `unref()`。`stop()` 可重复调用。

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `pnpm vitest run tests/runtime/daily-group-shutdown-worker.test.ts`

Expected: PASS。

- [ ] **Step 5: 接入服务生命周期**

在 `src/server.ts` 构造 worker；`app.onClose` 调用 `stop()`；服务监听成功后调用 `start()`。不在本机启动服务。

- [ ] **Step 6: 回归验证**

Run: `pnpm vitest run tests/runtime/daily-group-shutdown-worker.test.ts tests/telegram/runtime-learning-source.test.ts tests/support/technical-escalation.test.ts`

Expected: PASS。

### Task 3: 后台配置界面与固定规则

**Files:**
- Modify: `web/src/views/runtime.ts`
- Modify: `web/src/types.ts`
- Modify: `web/styles.css`
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 的 `RuntimeSettings.dailyGroupShutdown*` 字段和现有 `api.updateRuntimeSettings()`。
- Produces: “运行配置”中的每日关闭开关、`input[type=time]` 和只读最近运行摘要。

- [ ] **Step 1: 实现运行配置 UI**

在 `runtimeCard()` 增加开关和时间输入：

```ts
const groupShutdown = toggle("每日自动关闭所有群", settings.dailyGroupShutdownEnabled)
const groupShutdownTime = textInput("dailyGroupShutdownTime")
groupShutdownTime.type = "time"
groupShutdownTime.value = settings.dailyGroupShutdownTime
```

提交 payload 时只带 `dailyGroupShutdownEnabled` 与 `dailyGroupShutdownTime`。显示“中国标准时间（Asia/Shanghai）”以及“尚未执行”或最近运行时间和停用数量。窄屏复用现有单列响应式布局，不新建菜单。

- [ ] **Step 2: 更新长期规则和 README**

把 `AGENTS.md` 的固定项目路径替换为当前工作区，并增加已确认的每日全群停用、上海时区、当日补执行和同日幂等规则。README 的后台能力说明加入该配置入口，不写固定生产地址或凭据。

- [ ] **Step 3: 运行前端与契约验证**

Run: `pnpm vitest run tests/runtime/daily-group-shutdown-schema.test.ts && pnpm typecheck && pnpm build:web`

Expected: PASS，桌面和窄屏均无新增横向布局风险。

### Task 4: 全量验证、提交、推送和 Linux 部署

**Files:**
- Verify: all changed files
- Read: restricted deployment configuration outside Git
- Modify remotely: existing checked-out application revision and systemd service only

**Interfaces:**
- Consumes: Tasks 1–3 的通过测试、构建产物和提交。
- Produces: 已推送提交与健康的 Linux 部署，服务仍只监听 `127.0.0.1:3210`。

- [ ] **Step 1: 运行完整本机验证**

Run: `pnpm test && pnpm typecheck && pnpm build && git diff --check`

Expected: 全部命令 exit 0；无失败、类型错误或格式错误。

- [ ] **Step 2: 检查范围并提交**

Run: `git status --short && git diff --stat && git diff`

确认只包含本功能、设计/计划与用户明确要求的固定规则更新。提交：

```bash
git add AGENTS.md README.md src web tests docs/superpowers/plans/2026-08-15-daily-group-shutdown.md
git commit -m "功能：支持每日自动关闭全部群"
```

- [ ] **Step 3: 推送准确提交**

推送当前 `codex/` 分支，并按既有发布流程把同一提交更新到生产部署分支。推送前确认远端差异，禁止覆盖其他人的新提交。

- [ ] **Step 4: 在既有 Linux 目标部署**

从现有受限本地部署配置解析服务器、SSH 用户、私钥、远端目录和 systemd 单元，不把任何值输出到日志或提交到 Git。记录远端部署前提交；在服务器拉取精确已推送提交，执行锁定依赖安装、`pnpm test`、`pnpm typecheck`、`pnpm build`，然后重启既有 systemd 单元。不得替换、删除或清空生产 SQLite。

- [ ] **Step 5: 生产验收和回滚门槛**

验证：

```text
systemd = active
GET http://127.0.0.1:3210/health = success
监听地址 = 仅 127.0.0.1:3210
SQLite schema_version = 26
daily_group_shutdown_schedule = 单行、默认或现有配置有效
近期 journal = 无迁移错误和 daily_group_shutdown 错误
```

若任一门槛失败，恢复部署前提交、重新构建并重启，再重复健康检查；业务 SQLite 保留 v26，不执行降级或破坏性迁移。

- [ ] **Step 6: 最终一致性报告**

报告本地提交、生产提交、测试数量、systemd/health/listen/schema 证据和当前计划是否启用。不得回显生产地址、认证信息、SQLite 路径或群 ID。
