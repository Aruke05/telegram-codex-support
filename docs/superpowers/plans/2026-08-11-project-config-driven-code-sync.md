# 基于项目配置的代码定时同步实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有项目管理中已启用且完成服务配置的非 Peakpay 服务每 30 分钟进入错峰代码同步 不再受 Telegram 群绑定和启用状态影响

**Architecture:** 保留现有 SQLite 持久化到期表 每分钟一次领取 全局最大并发 1 和服务双仓顺序拉取 只修改定时领取查询的资格来源 固定规则同步更新为项目配置驱动 部署后利用已有逾期计划自然分批补同步

**Tech Stack:** Node.js 22 TypeScript 5.9 SQLite Vitest systemd

## Global Constraints

- 项目启用且服务启用时进入定时同步
- Peakpay 永久排除
- 群配置不得影响代码同步资格
- 同一时间最多同步一个服务 同一服务双仓依次拉取
- 周期保持 30 分钟 调度器每分钟最多领取一个到期服务
- 不提交测试文件或测试代码
- Git 提交信息 推送说明和状态反馈使用中文
- 只在 `DEPLOY_HOST` 完成类型检查 测试 构建和部署验收

---

### Task 1: 建立项目配置驱动的回归边界

**Files:**
- Temporary test: `tests/tmp-project-config-code-sync.test.ts`
- Modify: `src/git-sync/hourly-worker.ts`

**Interfaces:**
- Preserves: `HourlyCodeSyncWorker.runDueOnce(now): Promise<number>`
- Changes: 到期服务资格不再要求 `telegram_groups` 记录

- [ ] **Step 1: 写临时失败测试**

创建启用项目 启用服务 双仓绑定和已到期计划 但不创建 Telegram 群 调用 `runDueOnce` 后断言返回 1 且 fake codeSync 收到该服务 ID

另覆盖项目停用 服务停用和 `service_key=peakpay` 时返回 0

- [ ] **Step 2: 在部署服务器确认 RED**

Run: `pnpm vitest run tests/tmp-project-config-code-sync.test.ts`

Expected: 未绑群的启用服务未被领取 测试失败

- [ ] **Step 3: 最小修改领取查询**

从 `HourlyCodeSyncWorker.claim` 的 SQL 删除 `telegram_groups` EXISTS 条件 保留以下条件

```sql
schedule.next_hourly_sync_at <= ?
AND service.enabled = 1
AND project.enabled = 1
AND lower(service.service_key) <> 'peakpay'
```

- [ ] **Step 4: 在部署服务器确认 GREEN**

Run: `pnpm vitest run tests/tmp-project-config-code-sync.test.ts`

Expected: 项目和服务启用的未绑群服务被领取 停用配置和 Peakpay 仍被排除

- [ ] **Step 5: 删除临时测试**

删除 `tests/tmp-project-config-code-sync.test.ts` 并确认 Git 状态中没有测试改动

### Task 2: 更新固定规则并提交

**Files:**
- Modify: `AGENTS.md`
- Modify: `src/git-sync/hourly-worker.ts`

**Interfaces:**
- Fixed rule: 定时同步由项目和服务启用配置驱动

- [ ] **Step 1: 更新固定规则**

把至少绑定一个已启用客服群的资格规则替换成项目和服务启用规则 明确群配置只控制消息接入

- [ ] **Step 2: 静态检查**

Run: `git diff --check`

Run: `rg -n "至少绑定了一个已启用客服群|尚未开群的服务" AGENTS.md src/git-sync/hourly-worker.ts`

Expected: 无旧规则命中

- [ ] **Step 3: 提交**

```bash
git add AGENTS.md src/git-sync/hourly-worker.ts docs/superpowers/specs/2026-08-11-project-config-driven-code-sync-design.md docs/superpowers/plans/2026-08-11-project-config-driven-code-sync.md
git commit -m "修复：按项目配置定时同步服务代码"
```

### Task 3: 服务器验证 部署和补同步观察

**Files:**
- No production file changes

**Interfaces:**
- Deploy target: `DEPLOY_HOST:/opt/telegram-codex-support/current`
- Service: `telegram-codex-support.service`

- [ ] **Step 1: 推送当前分支**

把当前提交推送到 `origin/codex/interface-document-diagnostic-boundary` 和生产部署分支 `origin/telegram-ai-support`

- [ ] **Step 2: 在部署服务器完整验证**

Run: `pnpm typecheck && pnpm test && pnpm build`

Expected: 全部退出码为 0

- [ ] **Step 3: 重启并检查健康**

确认服务器工作树切到本次提交后重启 `telegram-codex-support.service` 验证 systemd 为 active 且 `/health` 返回 ok

- [ ] **Step 4: 观察逾期任务分批恢复**

只读查询生产 SQLite 的同步批次和调度表 验证未绑定启用群的服务开始产生部署后的 hourly 批次 且每分钟最多新增一个服务

- [ ] **Step 5: 最终一致性检查**

确认服务器提交和生产分支提交一致 本地工作树干净 不存在临时测试文件
