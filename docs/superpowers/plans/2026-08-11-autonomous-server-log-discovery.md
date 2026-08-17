# 回答 AI 自主服务器日志发现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 回答 AI 在当前绑定服务器上自主发现并限量读取任意实际日志来源 且后台保留真实脱敏证据

**Architecture:** 回答会话继续直接 SSH 当前绑定服务器 代码只校验目标服务器与只读性质 不再限定日志目录或服务名 Codex CLI 返回的实际命令结果作为服务器和日志证据 数据库结果继续由父进程复核

**Tech Stack:** TypeScript Node.js Codex CLI SSH systemd Docker Kubernetes Vitest

## Global Constraints

- 不新增或提交测试文件
- 所有运行验证只在 `DEPLOY_HOST` 执行
- 只访问当前群绑定服务的服务器
- 服务器 数据库 Redis 和四方支付代码继续只读
- 大日志必须按时间 关键词和条数限量
- 最终输出继续做敏感信息拦截

---

### Task 1: 记录旧版日志命令校验失败

**Files:**
- Read: `src/support/trusted-command-observation.ts`

**Interfaces:**
- Consumes: `validateTrustedCommandObservation(observation, context)`
- Produces: 旧版拒绝自主日志发现命令的红灯证据

- [ ] **Step 1: 在服务器运行一次性断言**

断言当前版本应接受任意目录文件日志 `tail` `docker logs` `kubectl logs` 和只读 `find` 发现命令 并继续拒绝 `rm` `systemctl restart` 与输出重定向

- [ ] **Step 2: 确认旧版本按预期失败**

Expected: 前四项至少一项失败 写操作拒绝项通过

### Task 2: 放开服务器日志发现但保留只读门禁

**Files:**
- Modify: `src/support/trusted-command-observation.ts`

**Interfaces:**
- Consumes: 只通过本题临时 `ssh_config` 发往 `support-N` 的命令观察
- Produces: `validateRemoteReadonly(command): "server" | "log" | "redis" | null`

- [ ] **Step 1: 提取远程命令文本**

保留 SSH 配置路径和目标别名校验 同时兼容 Codex CLI 的直接 SSH 和外层 shell 包装 取得完整命令供只读分类

- [ ] **Step 2: 增加确定性写操作拒绝**

拒绝输出重定向 删除 移动 写文件 重启 部署 安装 修改权限 结束进程 网络下载 数据库写语句和 Redis 写命令 允许只读管道 输入脚本 命令替换和多步发现

- [ ] **Step 3: 分类自主只读命令**

日志读取和日志发现命令归为 `log` 进程 单元 容器和文件系统发现归为 `server` Redis 只读命令归为 `redis` 不检查日志目录名称

### Task 3: 记录真实服务器和日志证据

**Files:**
- Modify: `src/support/investigation-service.ts`

**Interfaces:**
- Consumes: `CodexCommandObservation.command output exitCode`
- Produces: 脱敏后的 `InvestigationStep`

- [ ] **Step 1: 保留限量命令输出**

通过校验的非数据库只读命令不再清空 `output`

- [ ] **Step 2: 映射真实状态**

按退出码和输出映射 `confirmed` `not_found` `failed` 并把命令与限量输出写入后台证据

- [ ] **Step 3: 保持统一脱敏**

沿用 `redactTrace` 对标题 证据 结论统一脱敏和截断

### Task 4: 去除固定服务名并更新回答说明

**Files:**
- Modify: `src/diagnostics/read-only-policy.ts`
- Modify: `src/support/agent.ts`
- Modify: `src/support/resource-workspace.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Produces: 通用服务器概览 固定 journald 摘要和自主日志发现提示

- [ ] **Step 1: 改造固定诊断命令**

`service_status` 返回通用运行服务与 Java 进程概览 `recent_logs` 返回通用 journald 限量错误计数 不再出现 `sfzf-service`

- [ ] **Step 2: 更新回答提示和临时说明**

明确模型可以自行检查 journald 容器和任意文件日志 不预设服务名 目录 后缀或框架

- [ ] **Step 3: 同步长期项目规则**

在 `AGENTS.md` 记录自主发现规则和不变的当前服务器 只读 限量 脱敏边界

### Task 5: 提交 推送 部署和真实验证

**Files:**
- Verify: all modified files

**Interfaces:**
- Consumes: Tasks 1 to 4
- Produces: `DEPLOY_HOST` 上运行的新版本

- [ ] **Step 1: 静态检查并提交**

Run: `git diff --check`

Commit: `优化：支持自主发现服务器日志`

- [ ] **Step 2: 推送当前分支和生产分支**

Run: `git push origin HEAD` and `git push origin HEAD:telegram-ai-support`

- [ ] **Step 3: 服务器构建验证**

Run: `pnpm typecheck && pnpm test && pnpm build`

Expected: 类型检查通过 现有测试通过 构建成功

- [ ] **Step 4: 服务器一次性绿灯断言**

验证任意目录日志 容器日志和发现命令通过 写命令拒绝 固定诊断不含 `sfzf-service`

- [ ] **Step 5: 重启并检查生产状态**

验证 `/health` `/api/runtime-status` 服务状态和最新日志无新增错误
