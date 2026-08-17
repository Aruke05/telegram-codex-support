# Daily Group Shutdown Reschedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修改每日关闭时间时清除旧计划的当天执行日期，使新时间当天可再次触发。

**Architecture:** 在现有运行配置事务中比较旧、新时间，并用 SQLite `CASE` 只在时间变化时把 `last_run_local_date` 设为 `NULL`。worker 和 schema 不变。

**Tech Stack:** TypeScript 5.9、Node.js 24、SQLite、Vitest 3、systemd。

## Global Constraints

- 固定使用 `Asia/Shanghai`。
- 保留最近执行时间和关闭数量审计。
- 相同时间保存不得解除同日幂等限制。
- 不修改 Telegram 账号和全局 Telegram 开关。

---

### Task 1: 改时重排

**Files:**
- Modify: `tests/runtime/daily-group-shutdown-schema.test.ts`
- Modify: `src/runtime/model-config-service.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `ModelConfigService.updateSettings(input)`。
- Produces: 时间变化时 `daily_group_shutdown_schedule.last_run_local_date=NULL`。

- [ ] **Step 1: 写两个回归测试**

设置已有当天执行记录；分别保存不同时间和相同时间，断言前者清空 `last_run_local_date`、后者保留。

- [ ] **Step 2: 验证 RED**

Run: `pnpm vitest run tests/runtime/daily-group-shutdown-schema.test.ts`

Expected: 不同时间用例失败，实际值仍为原执行日期。

- [ ] **Step 3: 最小实现**

把调度更新 SQL 改为：

```sql
UPDATE daily_group_shutdown_schedule
SET enabled=?,local_time=?,
    last_run_local_date=CASE WHEN local_time<>? THEN NULL ELSE last_run_local_date END,
    updated_at=?
WHERE id=1
```

- [ ] **Step 4: 验证 GREEN 和完整门禁**

Run: `pnpm vitest run tests/runtime/daily-group-shutdown-schema.test.ts && pnpm test && pnpm typecheck && pnpm build && git diff --check`

Expected: 全部退出码为 0。

- [ ] **Step 5: 提交、推送和部署**

推送精确提交到生产分支；生产机运行锁定依赖安装、测试、类型检查和构建，重启既有 systemd 单元，核对提交、健康、监听、schema 和 worker 日志。
