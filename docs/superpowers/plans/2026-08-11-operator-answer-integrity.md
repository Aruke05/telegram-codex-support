# 客服回复内容完整性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持客服回复自然少标点风格的同时 确保所有结构化业务值在发送前不会被格式化逻辑改写

**Architecture:** 将现有单正则占位方式改为结构化区间识别与合并 只格式化普通语言区间 恢复后再比较格式化前后的结构化值 如果完整性不一致则回退为非破坏性格式化

**Tech Stack:** TypeScript Node.js WHATWG URL `node:net` 现有 Vitest 与服务器部署流程

## Global Constraints

- 不新增外部依赖
- 不提交测试文件或测试代码
- 只修改客服回复格式化链路和对应提示文字
- 最终仍必须执行现有 business-outbound 敏感信息检查
- 所有验证在 `DEPLOY_HOST` 执行

---

### Task 1: 建立服务器失败场景基线

**Files:**
- Read: `src/support/operator-voice.ts`

**Interfaces:**
- Consumes: `humanizeOperatorAnswer(value: string, latestMessage?: string): string`
- Produces: 一次性失败矩阵输出 不写入项目

- [ ] **Step 1: 运行现网一次性脚本**

在服务器导入 `dist/support/operator-voice.js` 对域名 域名端口 IPv6 千分位 JSON Java 类名 URL 路径执行格式化

- [ ] **Step 2: 确认失败属于格式化改写**

期望旧实现至少出现域名点 IPv6 冒号 千分位逗号或 JSON 标点丢失 证明场景能捕获当前缺陷

### Task 2: 实现结构化区间保护

**Files:**
- Modify: `src/support/operator-voice.ts`

**Interfaces:**
- Consumes: 原始客服回复文本
- Produces: `structuredSpans(value: string): TextSpan[]` `protectStructuredContent(value: string)` `structuredValues(value: string): string[]`

- [ ] **Step 1: 定义区间模型**

增加 `{ start: number; end: number; value: string }` 类型 区间使用左闭右开索引

- [ ] **Step 2: 识别结构化值**

识别 code JSON URL 路径 IP 域名与点分标识 数字格式 时间 日期和版本 使用 `net.isIP` 与 WHATWG `URL` 验证可解析类型

- [ ] **Step 3: 合并重叠区间**

按 start 升序和 end 降序排序 包含区间只保留外层 相交区间合并为原文连续区间

- [ ] **Step 4: 使用随机无冲突占位符保护区间**

占位符只在函数内存活 恢复时按索引取原始值 不把业务文本拼进占位符

### Task 3: 增加完整性回退

**Files:**
- Modify: `src/support/operator-voice.ts`

**Interfaces:**
- Consumes: 格式化前后的结构化值序列
- Produces: 完整格式化结果或非破坏性回退结果

- [ ] **Step 1: 拆分安全与破坏性格式化**

安全阶段只替换报告腔 合并空白 限制两行 破坏性阶段只在受保护内容之外把标点变为空格

- [ ] **Step 2: 比较结构化值序列**

格式化完成后重新提取结构化值 必须与原始序列逐项完全相同

- [ ] **Step 3: 完整性失败时回退**

若数量 值或顺序不同 返回仅经过安全阶段的结果 不发送已损坏文本

### Task 4: 对齐模型 Guidance

**Files:**
- Modify: `src/support/agent.ts`
- Modify: `src/runtime/knowledge-service.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: 客服语气固定规则
- Produces: 内容完整性优先规则

- [ ] **Step 1: 更新回答提示**

明确少标点只针对普通语言 URL IP 域名端口 金额 时间 日期 版本 JSON 参数和错误标识必须原样输出

- [ ] **Step 2: 更新系统固定规则与项目记忆**

写明不得为了口语化改变任何业务值 结构化值完整性高于少标点风格

### Task 5: 服务器验证和部署

**Files:**
- Verify: production branch and `/opt/telegram-codex-support/current`

**Interfaces:**
- Consumes: 完成的代码提交
- Produces: 服务器测试 构建 场景矩阵 服务健康证据

- [ ] **Step 1: 推送生产分支**

推送 `HEAD:telegram-ai-support`

- [ ] **Step 2: 在服务器执行完整检查**

运行 `pnpm typecheck && pnpm test && pnpm build`

- [ ] **Step 3: 重启服务并检查健康**

确认 systemd 为 `active` 且 `/health` 返回正常

- [ ] **Step 4: 运行一次性回归矩阵**

断言设计文档中的所有结构化场景原样保留 同时普通中文仍完成去标点 报告腔替换和两行限制

- [ ] **Step 5: 提交与生产一致性检查**

确认本地远端生产分支和服务器提交一致且工作区干净
