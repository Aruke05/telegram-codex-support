# AI 客服自主只读排查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除固定表名和固定证据步骤对回答的干预 让回答 AI 阅读当前代码后自主选择服务器 数据库 Redis 日志和文档完成只读排查

**Architecture:** Codex 回答会话继续获得当前绑定服务的隔离资源工作区和全权限本地执行能力 模型负责业务排查路径 确定性代码只负责安全重答 查询审计 敏感信息出站和代码缺陷升级验证 数据库审计以通用只读查询步骤合并到调查轨迹但不再决定答案是否放行

**Tech Stack:** TypeScript Node.js Codex CLI SSH SQLite Vitest

## Global Constraints

- 不新增或提交测试文件
- 所有最终构建和真实回答验证在 `DEPLOY_HOST` 执行
- 生产服务器 支付代码 数据库 Redis 和业务配置继续只读
- 当前群绑定服务是唯一可访问业务范围
- 路由和学习会话继续使用 `read-only` 回答诊断会话继续使用 `danger-full-access`
- 服务器 数据库和 Redis 凭据 商户密钥 Token Session 私钥和基础设施地址禁止外发
- Peakpay 永久排除

---

### Task 1: 记录旧行为红灯证据

**Files:**
- Read: `src/support/investigation-service.ts`
- Read: `src/support/answer-worker.ts`
- Read: `src/support/agent.ts`
- Read: `src/runtime/knowledge-service.ts`

**Interfaces:**
- Consumes: 当前固定追问函数和固定证据门禁
- Produces: 一次性断言输出 证明订单号充分时仍会被改写成固定资料追问

- [ ] **Step 1: 运行一次性源码断言**

从标准输入运行 Node 脚本 检查源码仍包含 `missingOrderEvidenceReply` `missingRequiredInvestigationEvidence` `requestMissingOrderEvidence` 和 `sys_log` `channel_log` 强制提示

- [ ] **Step 2: 确认红灯**

Expected: 旧实现断言这些固定限制存在并输出 `old-fixed-gates-present`

### Task 2: 删除确定性业务证据门禁和答案覆盖

**Files:**
- Modify: `src/support/investigation-service.ts`
- Modify: `src/support/answer-worker.ts`

**Interfaces:**
- Consumes: `AnswerDecision` 和现有安全判断函数
- Produces: 仅针对升级 技术群文案 过度技术化和敏感出站的三次安全重答循环

- [ ] **Step 1: 删除固定业务分类和证据检查**

删除 `missingOrderEvidenceReply` `missingRequiredInvestigationEvidence` `completedEvidenceStep` 以及订单主表 商户侧 上游侧 服务器指标的固定模式

- [ ] **Step 2: 收窄重答循环**

移除 `missingEvidenceInstruction` 和 `requestMissingOrderEvidence` 调用 三次循环只检查 `unverifiedEscalation` `unsafeOperatorAnswer` `tooTechnical` `unsafeOutbound`

- [ ] **Step 3: 修改最终安全兜底**

连续三次安全校验失败时保留 `safeFallback()` 的中性回答 不再根据问题关键词推断缺失资料

- [ ] **Step 4: 修改 worker 异常兜底**

超时 调查运行异常和无代码快照分支直接使用各自现有中性兜底 删除所有 `missingOrderEvidenceReply` 覆盖

- [ ] **Step 5: 运行静态检查**

Run: `git diff --check`

Expected: exit 0

### Task 3: 把数据库审计改成通用只读审计

**Files:**
- Modify: `src/support/investigation-service.ts`
- Keep: `src/support/resource-workspace.ts`

**Interfaces:**
- Produces: `databaseAuditSteps(auditPath: string): InvestigationStep[]`
- Consumes: `.database-query-audit.jsonl` 中每条只读助手记录

- [ ] **Step 1: 删除固定表识别**

`databaseAuditSteps` 不再识别订单主表 `sys_log` 或 `channel_log` 不再要求 SQL 包含订单号

- [ ] **Step 2: 记录所有本题只读查询**

每条成功或失败的审计统一生成 `source=database` 标题为 `执行数据库只读查询` 状态按 `ok` 和 `rowCount` 映射 evidence 保留限长 SQL 行数和最多三个脱敏前样本

- [ ] **Step 3: 保持审计不参与放行**

`mergeDatabaseAudit` 只把审计附加到 `investigation.steps` 任何表名和查询结果都不影响回答循环是否结束

### Task 4: 改写回答提示词为代码优先自主排查

**Files:**
- Modify: `src/support/agent.ts`
- Modify: `src/support/resource-workspace.ts`

**Interfaces:**
- Consumes: 当前服务代码快照和资源工作区
- Produces: 不指定表名和固定步骤的自主排查提示

- [ ] **Step 1: 删除固定订单表提示**

删除订单主记录 `sys_log` `channel_log` 的固定步骤和固定表名指令 删除固定商户参数追问

- [ ] **Step 2: 增加通用自主排查规则**

明确要求 AI 先从当前服务代码理解业务入口 数据结构 日志位置 配置和调用链 再自主选择 SSH 数据库 Redis 日志 nginx 或接口文档

- [ ] **Step 3: 明确追问时机**

消息已有订单号 时间 地址 IP 或错误内容等定位信息时必须先使用现有资源 不让运营重复提供 只有实际尝试代码和可用资源后仍缺外部业务信息时才追问最少内容

- [ ] **Step 4: 更新资源说明**

`READ_ONLY.md` 保留数据库助手使用方式 说明表和字段由 AI 根据当前代码与 `SHOW` 自主确定 不规定业务表名

### Task 5: 同步固定规则和项目权威记忆

**Files:**
- Modify: `src/runtime/knowledge-service.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Produces: 启动时自动替换到 SQLite 的新系统固定规则

- [ ] **Step 1: 收窄接口文档边界规则**

保留接口文档只回答接口定义和内部错误不得外发 删除固定追问商户参数和平台响应

- [ ] **Step 2: 替换固定证据规则**

把 `订单与服务器必查证据` 替换为 `自主只读排查` 内容要求代码优先 AI 自主选择资源 不用固定表和步骤决定答案

- [ ] **Step 3: 更新 AGENTS.md**

删除固定表名与确定性证据门禁要求 写入自主排查 查询审计只复核不放行和实际尝试后才追问

### Task 6: 一次性断言和本地静态验证

**Files:**
- Verify: all modified files

**Interfaces:**
- Consumes: Tasks 2 to 5
- Produces: 不提交测试文件的绿灯证据

- [ ] **Step 1: 运行源码绿灯断言**

从标准输入执行 Node 脚本 断言生产代码不再包含 `missingOrderEvidenceReply` `missingRequiredInvestigationEvidence` `requestMissingOrderEvidence` 和固定表名指令

- [ ] **Step 2: 断言安全边界仍存在**

断言提示词仍包含绑定服务唯一 生产只读 敏感信息禁止外发 当前代码缺陷才能升级 数据库从绑定服务器内访问

- [ ] **Step 3: 本地静态检查**

Run: `git diff --check`

Expected: exit 0

- [ ] **Step 4: 提交实现**

Commit: `修复：让回答 AI 自主选择只读排查路径`

### Task 7: 推送部署和真实问题验证

**Files:**
- Verify: deployment branch and server runtime

**Interfaces:**
- Consumes: Task 6 commit
- Produces: `DEPLOY_HOST` 运行版本和真实回答证据

- [ ] **Step 1: 推送生产分支**

Run: `git push origin HEAD:telegram-ai-support`

- [ ] **Step 2: 服务器构建验证**

Run: `pnpm typecheck && pnpm test && pnpm build`

Expected: 类型检查通过 现有测试全部通过 构建成功

- [ ] **Step 3: 重启客服服务**

更新 `/opt/telegram-codex-support/current` 后重启 `telegram-codex-support.service`

- [ ] **Step 4: 验证系统固定规则迁移**

确认 SQLite 中系统规则为 `自主只读排查` 且不再包含固定商户参数追问和固定表名门禁

- [ ] **Step 5: 运行原问题真实回答会话**

使用 MCBPay 和订单 `DF202608101514423565993` 的原始问题 验证回答不再固定追问商户下单参数 并且调查路径由 AI 根据当前代码和生产只读资源自主形成

- [ ] **Step 6: 检查运行状态**

验证 systemd 为 `active` `/health` 返回 `ok` Codex 已认证 Telegram Bot 循环正常
