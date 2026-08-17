# 多厂商模型管理与群级路由实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加可复用的多厂商模型别名、回答与记忆运行绑定、技术群专用模型、群级回复风格，并让 Codex CLI 与官方 API 模型都能走同一套受控回答链路。

**Architecture:** SQLite 保存模型实例和用途绑定，API 密钥由现有本机密钥库加密；`ModelGateway` 在任务开始时冻结模型快照并分发给 Codex CLI 或厂商 API 适配器。API 模型只能通过宿主侧 `ReadonlyAgentToolBroker` 读取代码、服务器、数据库和 Redis 证据。技术告警群在调查策略层关闭 AI 记忆与学习，但保留固定规则、代码、按问题触发的接口文档和 MagicBook。

**Tech Stack:** Node.js 22、TypeScript、Fastify、Zod、SQLite、原生 Fetch、原生 TypeScript/CSS 前端、Codex App Server JSONL。

## Global Constraints

- [ ] 只修改本项目代码和本地运行数据；生产资源继续只读。
- [ ] 不安装、启动或重启本机客服常驻服务，不把本机检查当作上线验收。
- [ ] API 密钥不进入提示词、普通日志、客服记录或迁移库。
- [ ] 所有新增测试均使用临时 `*.tdd.test.ts` 文件，红绿验证后删除，不提交测试文件或测试代码。
- [ ] 每个任务提交前运行针对性验证，提交信息使用中文，只暂存本任务文件和计划文件。

---

## Task 1：建立 v13 数据模型与安全迁移

**Files:**

- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/database.ts`
- Modify: `src/runtime/backup-service.ts`
- Modify: `src/runtime/admin-service.ts`
- Temporary test: `tests/runtime/model-schema-v13.tdd.test.ts`（验证后删除）

- [ ] **Step 1：写出失败的迁移测试**

临时测试覆盖：v12 的 answer/memory 两行迁移成“默认回答模型”和“默认记忆模型”；超时和并发进入用途绑定；技术告警群绑定默认回答模型；已有群默认 `reply_style=human`；API 凭据和目录缓存不进入便携库。

Run: `pnpm vitest run tests/runtime/model-schema-v13.tdd.test.ts`

Expected: FAIL，缺少 v13 表和群字段。

- [ ] **Step 2：增加运行时类型与校验 Schema**

在 `src/runtime/types.ts` 增加并导出：

```ts
export const modelProviderSchema = z.enum(["openai", "deepseek", "anthropic", "glm"])
export const modelTransportSchema = z.enum(["codex_cli", "direct_api"])
export const modelReasoningEffortSchema = z.enum([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]).nullable()
export const modelServiceTierSchema = z.enum(["standard", "fast", "priority"]).nullable()
export const replyStyleSchema = z.enum(["human", "unrestricted"])
export type ModelInstanceRecord = { /* v13 model_instances 的非密钥字段和凭据状态 */ }
export type RuntimeModelBinding = { /* purpose、modelInstanceId、timeoutSeconds、maxConcurrency、enabled */ }
```

扩展 `runtimeGroupSchema`：`aiModelInstanceId: z.string().uuid().nullable()` 和 `replyStyle`。

- [ ] **Step 3：实现单事务 v12→v13 迁移和全新库建表**

在 `src/runtime/database.ts`：

- `CURRENT_SCHEMA_VERSION` 提升到 13。
- 新建 `model_instances`、`model_catalog_entries`、`runtime_model_bindings`。
- `telegram_groups` 增加 `ai_model_instance_id` 与 `reply_style`。
- 使用确定性 UUID 迁移两条旧用途记录，检查旧记录完整性后才落表。
- 迁移技术告警群引用默认回答实例，删除 `model_profiles`，最后写 schema version。
- 更新 `readGroups()`、`insertGroup()`、清理和种子路径。

- [ ] **Step 4：更新群管理和便携导入导出**

`AdminService` 保存、读取并校验群模型与回复风格：客服群强制清空 `aiModelInstanceId`，技术告警群启用时要求有效模型。

`BackupService` 导出模型实例非敏感字段、用途绑定和群引用；跳过 `model_catalog_entries`；将 API 模型凭据/健康详情清空并停用。导入版本改为 13，并在一个事务中复制新表。

- [ ] **Step 5：验证并删除临时测试**

Run: `pnpm vitest run tests/runtime/model-schema-v13.tdd.test.ts && pnpm typecheck`

Expected: PASS。

删除临时测试，确认用户现有 `tests/knowledge/interface-scope.test.ts` 未改动。

- [ ] **Step 6：提交**

```bash
git add src/runtime/types.ts src/runtime/database.ts src/runtime/backup-service.ts src/runtime/admin-service.ts
git commit -m "功能：迁移模型实例与运行绑定数据结构"
```

---

## Task 2：实现模型实例服务、凭据保护和管理 API

**Files:**

- Rewrite: `src/runtime/model-config-service.ts`
- Modify: `src/security/dlp.ts`
- Modify: `src/routes/model-config.ts`
- Modify: `src/app.ts`
- Modify: `src/server.ts`
- Temporary test: `tests/runtime/model-instance-service.tdd.test.ts`（验证后删除）

- [ ] **Step 1：写出失败的服务测试**

覆盖：别名唯一；厂商/接入矩阵；未知参数拒绝；密钥加密落库且读取只暴露 `credentialsConfigured` 和末四位；被用途或技术群引用时禁止删除并列出引用；运行绑定只能指向已启用模型；编辑空密钥保留原密钥。

- [ ] **Step 2：将 `ModelConfigService` 改为模型实例与用途绑定服务**

构造函数接收 `RuntimeDatabase` 与 `LocalSecretVault`，提供：

```ts
listModelInstances(): ModelInstanceRecord[]
getModelInstance(id: string, options?: { includeCredential?: boolean }): ModelInstanceSnapshot
createModelInstance(input: CreateModelInstanceInput): Promise<ModelInstanceRecord>
updateModelInstance(id: string, input: UpdateModelInstanceInput): Promise<ModelInstanceRecord>
deleteModelInstance(id: string): void
listBindings(): RuntimeModelBinding[]
getBinding(purpose: ModelPurpose): RuntimeModelBinding
updateBinding(purpose: ModelPurpose, input: UpdateRuntimeModelBindingInput): RuntimeModelBinding
listConfiguredSecrets(): Promise<string[]>
```

`getModelInstance(...includeCredential)` 只供执行器和连接检测内部使用。所有公开 DTO 永不返回密文或明文密钥。

- [ ] **Step 3：把模型密钥纳入出站敏感信息集合**

让 `ConfiguredSecretRedactor` 通过窄接口异步取得已配置模型密钥，并继续复用既有日志/回复清洗逻辑。不得把密钥加入错误对象或调试输出。

- [ ] **Step 4：增加 CRUD、运行绑定和引用保护路由**

增加：

```text
GET    /api/models
POST   /api/models
PATCH  /api/models/:id
DELETE /api/models/:id
POST   /api/models/:id/test
GET    /api/model-bindings
PATCH  /api/model-bindings/:purpose
```

保留旧 `/api/model-config` 只做一个版本周期的只读兼容映射；前端改用新接口。错误响应只返回稳定错误码和脱敏中文说明。

- [ ] **Step 5：验证并提交**

Run: `pnpm vitest run tests/runtime/model-instance-service.tdd.test.ts && pnpm typecheck`

删除临时测试后提交：

```bash
git add src/runtime/model-config-service.ts src/security/dlp.ts src/routes/model-config.ts src/app.ts src/server.ts
git commit -m "功能：增加模型别名管理与凭据保护"
```

---

## Task 3：通过 Codex App Server 拉取完整模型目录

**Files:**

- Create: `src/models/catalog-types.ts`
- Create: `src/models/codex-catalog-client.ts`
- Create: `src/models/model-catalog-service.ts`
- Modify: `src/routes/model-config.ts`
- Modify: `src/server.ts`
- Temporary test: `tests/models/codex-catalog.tdd.test.ts`（验证后删除）

- [ ] **Step 1：写出失败的分页与缓存测试**

模拟 App Server JSONL，验证先 `initialize`/`initialized`，再循环 `model/list` 且 `includeHidden: true`；保留 `gpt-5.6-sol-wm`、`gpt-5.6-luna`、`gpt-5.5` 等隐藏项和各自推理强度；刷新失败返回最近成功缓存而不清空实例选择。

- [ ] **Step 2：实现短生命周期 App Server 客户端**

`CodexCatalogClient.listAll()` 使用本机 `codex app-server` 标准输入输出 JSONL，逐页跟随 `nextCursor`，设置短超时并在完成或异常时杀掉进程组。不得解析 `~/.codex/models_cache.json` 作为产品接口。

- [ ] **Step 3：实现目录归一化和 API 厂商能力目录**

`ModelCatalogService` 将 Codex 字段规范化为：模型 ID、显示名、隐藏/弃用/升级状态、默认推理档位、可选推理档位、支持的 service tier 和来源刷新时间。API 厂商第一版由适配器声明官方端点、模型 ID 自定义能力和参数规则。

- [ ] **Step 4：暴露目录刷新接口**

增加：

```text
GET  /api/model-catalog?provider=&transport=&includeHidden=
POST /api/model-catalog/refresh
```

响应携带 `refreshedAt`、`stale` 和脱敏刷新错误。

- [ ] **Step 5：验证并提交**

Run: `pnpm vitest run tests/models/codex-catalog.tdd.test.ts && pnpm typecheck`

删除临时测试后提交：

```bash
git add src/models src/routes/model-config.ts src/server.ts
git commit -m "功能：动态发现并缓存完整 Codex 模型目录"
```

---

## Task 4：建立统一 ModelGateway 并迁移 Codex CLI 执行

**Files:**

- Create: `src/models/errors.ts`
- Create: `src/models/types.ts`
- Create: `src/models/model-gateway.ts`
- Create: `src/models/codex-cli-adapter.ts`
- Modify: `src/codex/executor.ts`
- Modify: `src/support/agent.ts`
- Modify: `src/support/thread-router.ts`
- Modify: `src/learning/agent.ts`
- Modify: `src/learning/authoring.ts`
- Modify: `src/admin-chat/worker.ts`
- Modify: `src/server.ts`
- Temporary test: `tests/models/model-gateway.tdd.test.ts`（验证后删除）

- [ ] **Step 1：写出失败的网关测试**

验证：网关按任务开始时的模型快照执行；运行中配置变更不影响当前任务；按 `modelInstanceId + purpose` 控制并发；停用、缺凭据、超时和模型不存在转换为稳定错误码；不静默切换模型。

- [ ] **Step 2：定义统一执行请求和错误**

```ts
export type ModelExecutionRequest<T> = {
  modelInstanceId: string
  purpose: "answer" | "memory"
  cwd: string
  prompt: string
  outputSchema: Record<string, unknown>
  validator: z.ZodType<T>
  accessMode: "read-only" | "diagnostic"
  toolScope: AgentToolScope
  timeoutMs: number
  maxConcurrency: number
  signal?: AbortSignal
}

export class ModelExecutionError extends Error {
  readonly code: ModelExecutionErrorCode
}
```

- [ ] **Step 3：把现有 CLI 运行器封装为 `CodexCliAdapter`**

保留 `exec --ephemeral`、无审批、Schema、沙箱、最小环境、进程组终止和临时目录清理。模型、推理强度、service tier 全部来自冻结的模型实例，不再通过 purpose 查旧 profile。

- [ ] **Step 4：迁移所有 AI 调用方**

普通回答/路由/后台对话从回答绑定解析模型实例，学习与记忆编写从记忆绑定解析。调用方必须把用途绑定的 timeout/maxConcurrency 明确传入网关。

- [ ] **Step 5：验证并提交**

Run: `pnpm vitest run tests/models/model-gateway.tdd.test.ts && pnpm typecheck`

删除临时测试后提交：

```bash
git add src/models src/codex/executor.ts src/support/agent.ts src/support/thread-router.ts src/learning/agent.ts src/learning/authoring.ts src/admin-chat/worker.ts src/server.ts
git commit -m "重构：统一模型网关并迁移 Codex 执行链路"
```

---

## Task 5：增加官方 API 适配器与只读工具循环

**Files:**

- Create: `src/models/direct-api/http-client.ts`
- Create: `src/models/direct-api/openai-responses-adapter.ts`
- Create: `src/models/direct-api/anthropic-messages-adapter.ts`
- Create: `src/models/direct-api/openai-compatible-adapter.ts`
- Create: `src/models/direct-api/direct-api-adapter.ts`
- Create: `src/diagnostics/readonly-agent-tool-broker.ts`
- Modify: `src/support/trusted-command-observation.ts`
- Modify: `src/diagnostics/read-only-policy.ts`
- Modify: `src/diagnostics/resource-broker.ts`
- Modify: `src/models/model-gateway.ts`
- Modify: `src/server.ts`
- Temporary test: `tests/models/direct-api-tool-loop.tdd.test.ts`（验证后删除）

- [ ] **Step 1：写出失败的协议和安全测试**

使用本地伪 Fetch 验证 OpenAI Responses、Claude Messages、DeepSeek/GLM Chat Completions 的工具调用转换；最终 `submit_result` 参数经过 Zod；JSON 文本最多重试三次；工具循环最多 24 轮；认证、限流、额度、模型不存在和超时正确分类。验证模型只看到工具结果，绝不看到 SSH/数据库/API 凭据。

- [ ] **Step 2：把命令观察解析拆成可复用的执行前验证**

从 `trusted-command-observation.ts` 提取纯函数：

```ts
validateReadonlyCommand(input: { argv: string[]; cwd: string; scope: AgentToolScope }): ValidatedReadonlyCommand
validateTrustedObservation(observation: CommandObservation, scope: AgentToolScope): TrustedObservation
```

保留现有执行后证据门禁，同时让 API 工具在执行前拒绝 shell 拼接、写命令、越权路径和跨服务目标。

- [ ] **Step 3：实现 `ReadonlyAgentToolBroker`**

只公开 `search_code`、`read_code`、`read_git`、`server_check`、`read_recent_logs`、`database_query`、`redis_read`、`run_readonly_command`。每项都必须校验服务/路径/时间/行数/订单号边界，调用现有资源代理或数据库助手，并对返回值限长脱敏。数据库实际查询继续写入本题临时审计。

- [ ] **Step 4：实现三类官方协议适配器**

- OpenAI：固定 `https://api.openai.com/v1/responses`。
- Claude：固定 `https://api.anthropic.com/v1/messages`。
- DeepSeek：固定 `https://api.deepseek.com/chat/completions`。
- GLM：固定 `https://open.bigmodel.cn/api/paas/v4/chat/completions`。

不接受自定义 Base URL。参数按厂商能力转换；未知或不支持字段在发请求前抛 `parameter_unsupported`。

- [ ] **Step 5：接入网关和连接检测**

`ModelGateway` 按 transport/provider 分发。`POST /api/models/:id/test` 使用最小无工具请求验证鉴权和模型存在性，并保存脱敏健康状态；连接检测不得自动启用实例。

- [ ] **Step 6：验证并提交**

Run: `pnpm vitest run tests/models/direct-api-tool-loop.tdd.test.ts && pnpm typecheck`

删除临时测试后提交：

```bash
git add src/models src/diagnostics src/support/trusted-command-observation.ts src/server.ts
git commit -m "功能：接入多厂商 API 与受控只读工具循环"
```

---

## Task 6：实现技术群知识策略、群级模型和回复风格

**Files:**

- Create: `src/support/answer-policy.ts`
- Modify: `src/support/thread-coordinator.ts`
- Modify: `src/support/answer-worker.ts`
- Modify: `src/support/investigation-service.ts`
- Modify: `src/support/agent.ts`
- Modify: `src/runtime/knowledge-service.ts`
- Modify: `src/learning/worker.ts`
- Modify: `src/support/routing.ts`
- Modify: `src/runtime/admin-service.ts`
- Temporary test: `tests/support/group-answer-policy.tdd.test.ts`（验证后删除）

- [ ] **Step 1：写出失败的策略矩阵测试**

覆盖：

| 群类型 | 模型 | AI 记忆 | 接口文档 | MagicBook | 学习 | 回复风格 |
| --- | --- | --- | --- | --- | --- | --- |
| 客服群 | 回答绑定 | 是 | 仅显式接口问题 | 相关时 | 是 | 群配置 |
| 技术告警群 `/ai` | 群专属别名 | 否 | 仅显式接口问题 | 相关时 | 否 | 群配置 |

验证 `unrestricted` 不注入真人口吻、标点、长度、技术词限制，且跳过 `operatorCopy`/`operatorVoice`/`tooTechnical` 重试；两种风格仍执行 DLP、证据门禁、服务隔离和升级规则。

- [ ] **Step 2：集中生成不可变 `AnswerPolicy`**

```ts
type AnswerPolicy = {
  modelInstanceId: string
  includeAiMemory: boolean
  includeInterfaceDocs: boolean
  includeMagicBook: boolean
  enqueueLearning: boolean
  replyStyle: "human" | "unrestricted"
}
```

技术群从 `group.aiModelInstanceId` 取模型；普通客服从 answer binding 取。线程开始时冻结该策略供后续输入版本使用。

- [ ] **Step 3：重构静态知识检索**

固定规则始终加载。接口定义、路径、字段、签名问题才加载地区接口文档；MagicBook 按当前服务、地区、交易类型或银行编码相关性检索。技术群只关闭 AI memory，不关闭这两类静态知识。

- [ ] **Step 4：调整回答提示和验证门禁**

`human` 保留现有运营群自然口吻提示和重试；`unrestricted` 明确要求直接完整回答，不增加长度、标点、术语或人格约束。安全提示、只读限制、证据要求和结构化结果 Schema 始终相同。

- [ ] **Step 5：禁止技术群学习**

所有 `learning.enqueue(replyId)` 调用都通过策略检查；`LearningWorker.enqueue()` 再做一次确定性群类型校验，避免调用方遗漏。

- [ ] **Step 6：验证并提交**

Run: `pnpm vitest run tests/support/group-answer-policy.tdd.test.ts && pnpm typecheck`

删除临时测试后提交：

```bash
git add src/support src/runtime/knowledge-service.ts src/runtime/admin-service.ts src/learning/worker.ts
git commit -m "功能：支持技术群专属模型与群级回复策略"
```

---

## Task 7：实现模型管理与运行配置前端

**Files:**

- Create: `web/src/views/models.ts`
- Rename/Rewrite: `web/src/views/runtime.ts`（页面名称改为运行配置）
- Modify: `web/src/api.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/router.ts`
- Modify: `web/src/app.ts`
- Modify: `web/styles.css`
- Temporary test: `tests/web/model-management-view.tdd.test.ts`（验证后删除）

- [ ] **Step 1：写出失败的前端纯函数测试**

抽出并验证：厂商/接入矩阵；按目录能力过滤推理强度和加速项；API 密钥编辑空值不覆盖；隐藏/弃用/升级模型标记；运行用途只能选择已启用别名。

- [ ] **Step 2：增加类型和 API 客户端**

增加 `ModelInstance`、`ModelCatalogEntry`、`RuntimeModelBinding`、`ReplyStyle`。新增模型 CRUD、连接检测、目录刷新和用途绑定请求。移除 sol/terra 静态数组。

- [ ] **Step 3：创建“模型管理”页面**

列表显示别名、厂商、接入方式、真实模型、推理档位/加速、启用状态和连接状态。新增/编辑弹窗根据能力动态展示字段；API 模式显示密钥配置状态，Codex CLI 模式不显示密钥；引用中实例禁删并展示后端返回的引用。

- [ ] **Step 4：将旧页面改为“运行配置”**

回答模型与记忆模型均从已启用别名中选择，并保留各自超时、最大并发和启用开关。页面显示引用实例的厂商、接入方式和健康状态，但不能直接编辑模型参数。

- [ ] **Step 5：加入导航与克制的响应式样式**

新增独立路由 `models`，原 `runtime` 文案改为运行配置。验证长模型 ID、中文别名、状态徽标、弹窗滚动、窄屏按钮和深色模式。

- [ ] **Step 6：验证并提交**

Run: `pnpm vitest run tests/web/model-management-view.tdd.test.ts && pnpm typecheck && pnpm build:web`

删除临时测试后提交：

```bash
git add web/src/views/models.ts web/src/views/runtime.ts web/src/api.ts web/src/types.ts web/src/router.ts web/src/app.ts web/styles.css
git commit -m "功能：增加模型管理与运行配置页面"
```

---

## Task 8：扩展白名单群编辑和列表呈现

**Files:**

- Modify: `web/src/views/accounts-groups.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/styles.css`
- Modify: `src/routes/admin.ts`
- Temporary test: `tests/web/group-model-style-form.tdd.test.ts`（验证后删除）

- [ ] **Step 1：写出失败的群表单测试**

验证技术告警群出现“/ai 模型别名”且启用时必填；切回客服群会清空专属模型；所有白名单群显示“真人口吻/AI 原始回复”；列表展示对应徽标。

- [ ] **Step 2：扩展群 API DTO 和页面数据加载**

群管理连接数据同时加载已启用模型别名。创建/更新群时提交 `aiModelInstanceId` 与 `replyStyle`，后端返回引用失效或禁用模型时显示明确中文错误。

- [ ] **Step 3：完成桌面与窄屏交互**

保持现有账号/群抽屉结构，不产生横向滚动；技术群帮助文案说明 `/ai 服务 问题`、不带 AI 记忆但会按规则使用代码/接口文档/MagicBook。

- [ ] **Step 4：验证并提交**

Run: `pnpm vitest run tests/web/group-model-style-form.tdd.test.ts && pnpm typecheck && pnpm build:web`

删除临时测试后提交：

```bash
git add web/src/views/accounts-groups.ts web/src/types.ts web/src/api.ts web/styles.css src/routes/admin.ts
git commit -m "功能：扩展白名单群模型与回复风格配置"
```

---

## Task 9：文档、兼容清理和完整验收

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: implementation files only if verification finds defects

- [ ] **Step 1：更新项目权威记忆和使用文档**

将固定菜单更新为 `模型管理`、`运行配置` 两项；记录技术群 AI 记忆隔离、静态知识范围、群级回复风格、API 凭据迁移规则和 API Agent 受控工具边界。README 写清升级后首次配置和模型目录刷新方法。

- [ ] **Step 2：升级功能版本并检查旧接口引用**

将版本提升为 `1.1.0`。运行：

```bash
rg -n "model_profiles|gpt-5\.6-(sol|terra).*option|模型与运行" src web README.md AGENTS.md
```

只保留迁移代码、兼容接口和历史说明中的必要引用。

- [ ] **Step 3：执行完整自动验证**

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

确认没有提交任何 `*.tdd.test.ts`，用户现有未跟踪测试保持原样。

- [ ] **Step 4：执行真实页面验证**

只启动短生命周期开发进程用于页面 QA，不安装/重启常驻服务。检查：

- 浅色/深色模型管理页面。
- 浅色/深色运行配置页面。
- 技术群与客服群编辑弹窗。
- 1440px 桌面和 390px 窄屏，无横向溢出、底部按钮可触达、长模型 ID 可读。

结束后关闭临时进程，不把本机页面验证描述为上线验收。

- [ ] **Step 5：请求代码复核并修正高置信问题**

按 `superpowers:requesting-code-review` 复核数据库迁移、密钥处理、工具边界、技术群学习隔离和前端交互。修复后重新执行 Step 3。

- [ ] **Step 6：最终提交**

```bash
git add AGENTS.md README.md package.json pnpm-lock.yaml
git commit -m "文档：完善多模型配置说明并发布 1.1.0"
```

最终报告提交清单、验证结果、未部署说明，以及上线前需要在目标 Linux 上补填的 API 密钥和健康检查步骤。
