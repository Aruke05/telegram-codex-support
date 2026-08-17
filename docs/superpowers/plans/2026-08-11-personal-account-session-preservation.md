# Personal Account Session Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复个人 Telegram 账号登录成功后，单独启用账号会清空登录 session 的问题。

**Architecture:** 保留创建凭据的空 session 默认值，但让账号更新 DTO 的 session 真正保持可选。更新服务现有的身份变更和显式 session 变更逻辑保持不变。

**Tech Stack:** TypeScript、Zod 4、Node.js 22、SQLite、pnpm

## Global Constraints

- 只修改本项目代码，不写生产数据或修改其他服务。
- 不提交测试文件或测试代码。
- 回归脚本只在临时目录运行并在结束后清理。
- Git 提交信息、推送说明和状态反馈使用中文。

---

### Task 1: 复现账号更新会清空会话

**Files:**
- Inspect: `dist/runtime/admin-service.js`
- Runtime only: 服务器临时 SQLite 和主密钥

**Interfaces:**
- Consumes: `RuntimeAdminService.saveUserSession(id, session)` 和 `RuntimeAdminService.updateAccount(id, { enabled: true })`
- Produces: 修复前失败证据

- [x] **Step 1: 在服务器临时目录创建个人账号并保存固定测试 session**

使用 Node 内联脚本创建临时 `RuntimeDatabase`、`LocalSecretVault` 和 `RuntimeAdminService`，保存值为 `persisted-session` 的 session。

- [x] **Step 2: 仅提交启用字段并验证 session**

运行：`RuntimeAdminService.updateAccount(id, { enabled: true })`

预期：修复前脚本以非零状态退出，并报告 session 未被保留。

### Task 2: 让更新 session 字段保持真正可选

**Files:**
- Modify: `src/runtime/admin-service.ts:9-44`

**Interfaces:**
- Consumes: Zod 字符串校验器
- Produces: `userSessionSchema`，供创建凭据和账号更新分别组合

- [x] **Step 1: 提取无默认值的 session 校验器**

```ts
const userSessionSchema = z.string().max(20000)
```

- [x] **Step 2: 创建凭据保留空字符串默认值**

```ts
session: userSessionSchema.default("")
```

- [x] **Step 3: 更新请求不再继承创建默认值**

```ts
session: userSessionSchema.optional()
```

- [ ] **Step 4: 部署后在服务器执行验证**

运行：在 `DEPLOY_HOST` 的部署目录执行 `pnpm typecheck && pnpm test && pnpm build`

预期：类型检查、全部现有测试和构建通过。

### Task 3: 部署并完成服务器回归

**Files:**
- Deploy: `/opt/telegram-codex-support/current`

**Interfaces:**
- Consumes: 已推送提交和现有部署流程
- Produces: 服务器健康服务以及个人账号重新登录入口

- [ ] **Step 1: 提交并推送当前分支**

运行：`git commit -m "修复：启用个人账号时保留登录会话"` 并推送当前分支和部署分支。

- [ ] **Step 2: 在服务器更新、构建并重启服务**

服务器依次执行快进拉取、依赖校验、类型检查、现有测试、构建和服务重启。

- [ ] **Step 3: 再次运行一次性回归脚本**

预期：账号启用后 session 仍为 `persisted-session`，脚本以零状态退出并清理临时目录。

- [ ] **Step 4: 重新发起真实个人账号登录**

调用现有登录接口发送新验证码；完成验证码和两步验证后启用账号并执行连接检测。
