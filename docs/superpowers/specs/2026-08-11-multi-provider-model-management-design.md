# 多厂商模型管理与群级模型路由设计

## 背景

当前系统只有两条按用途固定的 `model_profiles` 记录：回答模型和记忆模型。运行页面同时承担模型参数和运行开关配置，前端模型下拉又只硬编码了 `gpt-5.6-sol` 与 `gpt-5.6-terra`。SQLite 默认记忆模型实际已经是 `gpt-5.6-luna`，但页面只能把它显示成自定义模型。

本机 Codex 目录当前还包含 `gpt-5.6-sol-wm`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini` 和 `gpt-5.3-codex-spark` 等可用模型，且每个模型支持的推理强度不同。继续在前端维护静态数组会持续遗漏模型和能力变化。

本次改造需要同时完成：

1. 增加可复用的模型管理能力，支持 ChatGPT / OpenAI、DeepSeek、Claude 和 GLM。
2. 支持 Codex CLI 与厂商 API 两类接入，其中 API 模型能够完整替代正式回答模型并使用受控只读工具。
3. 将“模型与运行”拆为“模型管理”和“运行配置”，运行用途只选择已配置的模型别名。
4. 为技术告警群 `/ai` 单独选择模型，并禁用 AI 记忆但保留正式链路的静态知识和排查能力。
5. 为每个白名单群独立配置真人口吻或 AI 原始回复。

## 调研结论

### Codex

Codex App Server 提供正式的 `model/list` 方法，可返回模型 ID、显示名称、隐藏状态、默认与可选推理强度、升级信息、输入模态和是否为默认模型。模型选择器应调用该方法，而不是读取前端硬编码数组。参考：[Codex App Server model/list](https://learn.chatgpt.com/docs/app-server#list-models-model-list)。

Codex 当前将 Sol 定位为复杂开放任务模型、Terra 定位为日常均衡模型、Luna 定位为清晰可重复任务模型。GPT-5.4 和 GPT-5.4 Mini 在 ChatGPT 登录方式下计划于 2026 年 8 月 31 日退出 Codex，但已有配置不应被本系统擅自删除，页面只显示官方返回的隐藏或升级状态。参考：[Codex 模型选择](https://learn.chatgpt.com/docs/models)。

Codex Fast 模式是模型能力，不是所有模型都有的通用参数。CLI 使用 `service_tier="fast"`；API Priority 计费与 ChatGPT Fast 额度也不是同一概念。因此“是否加速”必须按厂商、接入方式和模型能力转换，不能统一发送一个布尔字段。参考：[Codex Fast mode](https://learn.chatgpt.com/docs/agent-configuration/speed)。

Codex 自定义模型厂商当前只支持 Responses 协议。把所有第三方 API 简单塞入 Codex CLI 无法稳定覆盖 Claude、DeepSeek 和 GLM 的官方接口与推理参数，因此需要项目内统一执行器。参考：[Codex 自定义模型厂商](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)。

### 成熟多模型项目

Dify 将厂商凭据、模型实例、模型能力、参数规则以及预定义、远程发现、自定义模型三种配置方式分层，避免页面向所有模型发送相同参数。参考：[Dify 模型厂商设计](https://docs.dify.ai/en/develop-plugin/dev-guides-and-walkthroughs/creating-new-model-provider) 和 [Dify 模型能力与参数规则](https://docs.dify.ai/en/develop-plugin/features-and-specs/plugin-types/model-designing-rules)。

LiteLLM 使用面向业务的模型名绑定真实部署，并在路由层处理并发、限流、重试与故障，而调用方不依赖具体厂商。参考：[LiteLLM Router](https://docs.litellm.ai/docs/routing)。本项目复用其“稳定别名隔离真实模型”的思路，但不引入外部网关服务，以保持 SQLite 和单进程边界。

DeepSeek 官方接口兼容 OpenAI / Anthropic 消息格式并提供思考强度；Claude 使用 Messages API、工具调用和结构化输出；GLM 的 Chat Completions API 支持思考、工具调用和 JSON 输出。各厂商虽然都能完成 Agent 工作，但字段形状不同，必须由独立适配器转换。参考：[DeepSeek API](https://api-docs.deepseek.com/guides/reasoning_model)、[Claude Messages API](https://platform.claude.com/docs/en/api/messages/create)、[GLM 工具调用](https://docs.bigmodel.cn/cn/guide/capabilities/function-calling)。

## 总体架构

新增统一 `ModelGateway`，所有 AI 用途都通过模型别名调用它：

```text
回答 / 记忆 / 后台 AI 对话 / 技术群命令
                    │
                    ▼
              ModelGateway
              │          │
              ▼          ▼
      CodexCliAdapter   DirectApiAdapter
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
       OpenAI Responses  Claude      OpenAI-compatible
                       Messages      DeepSeek / GLM
                         │
                         ▼
               ReadonlyAgentToolBroker
                         │
        代码快照 / Git / SSH / DB / Redis
```

`ModelGateway` 的调用方只知道模型别名、用途、提示词、结构化结果 Schema、超时、取消信号和本题允许的工具范围。厂商鉴权、请求字段、工具调用协议、错误转换和最终 JSON 提取都封装在适配器内。

## 数据模型

### 模型实例

新增 `model_instances` 表，每一行代表后台可复用的模型别名：

| 字段 | 含义 |
| --- | --- |
| `id` | UUID 主键 |
| `alias` | 后台唯一模型别名 |
| `provider` | `openai`、`deepseek`、`anthropic`、`glm` |
| `transport` | `codex_cli` 或 `direct_api` |
| `model_id` | 厂商真实模型 ID |
| `reasoning_effort` | 可空的统一推理档位 |
| `service_tier` | `standard`、`fast`、`priority` 或厂商能力允许的空值 |
| `parameters_json` | 经过适配器 Schema 校验的非敏感参数 |
| `credentials` | 可空的 AES-256-GCM 加密凭据 JSON |
| `enabled` | 是否允许新任务使用 |
| `health_status` | `not_tested`、`ready`、`error` |
| `health_message` | 脱敏的最近检测结果 |
| `last_checked_at` | 最近检测时间 |
| `created_at` / `updated_at` | 审计时间 |

统一推理档位允许 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 和 `ultra`，但保存时必须经过当前模型能力校验。页面只显示所选模型支持的值。

`parameters_json` 第一版只允许适配器声明的字段，例如最大输出量、温度、输出详细度和思考开关。未知字段、凭据字段和厂商不支持的组合必须拒绝，不能把任意 JSON 透传给外部 API。

第一版接入矩阵：

| 厂商 | Codex CLI | API 密钥 |
| --- | --- | --- |
| ChatGPT / OpenAI | 支持，使用本机 ChatGPT 登录 | 支持，使用 OpenAI API |
| DeepSeek | 不支持 | 支持 |
| Claude | 不支持 | 支持 |
| GLM | 不支持 | 支持 |

不支持的组合在页面禁用并解释原因。未来某厂商稳定支持 Codex 所需 Responses 协议后，可以新增适配器能力而不改变调用方。

第一版只使用各厂商官方 API 地址，不开放任意 Base URL，避免后台配置成为 SSRF 出口。未来需要企业代理时，应增加明确的受信端点配置和主机白名单，而不是接受任意 URL。

### 模型目录缓存

新增 `model_catalog_entries` 运行缓存，记录厂商、接入方式、模型 ID、显示名称、能力 JSON、隐藏或弃用状态、升级目标与刷新时间。它不包含凭据，不属于权威业务数据，也不进入迁移库。

Codex CLI 目录通过 App Server `model/list` 分页获取，并使用 `includeHidden: true` 保存完整结果。页面默认展示可用模型，同时允许查看隐藏或待升级项。若刷新失败，保留最近一次成功目录并标记刷新时间；没有缓存时仍允许保留已有模型实例，不能把现有选择清空。

API 适配器优先使用厂商模型列表接口。厂商未提供稳定列表接口时，使用适配器内置的当前官方模型清单，同时提供“自定义模型 ID”。自定义 ID 仍需通过连接检测才能启用。

### 运行用途绑定

将当前 `model_profiles` 改造为 `runtime_model_bindings`：

| 字段 | 含义 |
| --- | --- |
| `purpose` | `answer` 或 `memory`，主键 |
| `model_instance_id` | 绑定的模型别名，外键限制删除 |
| `timeout_seconds` | 该用途单次运行上限 |
| `max_concurrency` | 该用途最大并发 |
| `enabled` | 是否启用该用途 |
| `updated_at` | 更新时间 |

推理强度、加速和生成参数属于模型别名；超时和并发属于运行用途。一个别名可以被多个用途或技术群复用。

回答绑定用于普通客服回答、问题线程路由和后台 AI 对话。记忆绑定用于人工记忆整理、纠错整理和后台自动学习。技术告警群 `/ai` 使用群配置覆盖回答别名，但沿用回答用途的超时和并发上限。

每个任务启动时读取不可变的模型配置快照。后台后续编辑只影响新任务，不改变已经生成中的任务。

### 白名单群

`telegram_groups` 新增：

| 字段 | 含义 |
| --- | --- |
| `ai_model_instance_id` | 技术告警群 `/ai` 使用的模型别名；客服群为空 |
| `reply_style` | `human` 或 `unrestricted` |

启用的技术告警群必须选择一个已启用、具备回答所需工具和结构化输出能力的模型别名。模型实例被运行用途或群引用时禁止删除，错误信息列出引用位置。

现有群迁移为 `reply_style=unrestricted`，按本次要求默认保留 AI 原始回复；后台仍可逐群切换为 `human`。现有技术告警群自动绑定迁移后的默认回答模型。

## 旧库迁移

数据库版本从 12 升级到 13：

1. 创建 `model_instances`、`model_catalog_entries` 和 `runtime_model_bindings`。
2. 读取原 `model_profiles` 的回答记录，创建别名“默认回答模型”，保留真实模型、推理强度和启用状态，厂商设为 `openai`，接入方式设为 `codex_cli`，加速设为标准。
3. 读取原记忆记录，创建别名“默认记忆模型”，同样保留原值。
4. 当前种子数据因此保持：回答 `gpt-5.6-terra / medium`，记忆 `gpt-5.6-luna / low`。
5. 将原超时、并发和启用状态写入两条运行用途绑定。
6. 给群增加新字段，技术告警群绑定默认回答模型。
7. 删除旧 `model_profiles`。

迁移必须在事务内完成。任何一条旧记录缺失或无法通过新 Schema 时回滚并报告版本不兼容，不能创建半迁移数据库。

## 凭据与迁移库

Codex CLI 模式不保存模型 API 密钥，继续使用本机 Codex 登录状态。

API 模式使用现有 `LocalSecretVault` 将 API 密钥加密后写入运行 SQLite。读取接口只返回：

- `credentialsConfigured: true | false`
- 末尾四位提示
- 最近检测状态

编辑时空密钥表示保留原值，明确执行“更换密钥”才覆盖。删除模型实例时一并删除其加密凭据。

模型 API 密钥加入出站 DLP 的本机敏感值集合，禁止进入提示词、普通日志、客服记录和 Telegram 回复。HTTP 适配器只在请求发送时把密钥写入认证 Header。

完整迁移 SQLite 保留模型别名、厂商、接入方式、模型 ID 和非敏感参数，但将 `credentials`、检测详情和检测时间清空。导入后：

- Codex CLI 模型可继续使用当前电脑的 Codex 登录。
- API 模型自动标记为未配置并停用。
- 运行用途和技术群仍保留别名引用，后台明确提示补填密钥后再启用。

模型目录缓存不导出。

## 统一执行接口

内部统一调用形态：

```ts
type ModelExecutionRequest<T> = {
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
```

`ModelGateway.execute()` 读取并冻结模型实例，按 `transport` 分发到适配器，并按 `modelInstanceId + purpose` 管理并发。停用、缺少凭据、模型能力不满足或连接检测失败时返回可分类错误。

错误统一为：

- `model_disabled`
- `credentials_missing`
- `authentication_failed`
- `quota_exhausted`
- `rate_limited`
- `model_not_found`
- `parameter_unsupported`
- `structured_output_invalid`
- `tool_loop_exhausted`
- `provider_timeout`
- `provider_unavailable`

错误只保留厂商、模型别名、HTTP 状态类别和脱敏说明，不保存提示词、密钥、完整厂商响应或生产数据。

## Codex CLI 适配器

Codex CLI 继续使用当前安全属性：

- `exec --ephemeral`
- `--ask-for-approval never`
- 结构化输出 Schema
- 回答会话 `danger-full-access`
- 路由与记忆会话 `read-only`
- 最小环境变量
- 独立进程组与超时清理
- 临时资源目录结束即删除

每次调用从模型实例快照写入 `-m`、`model_reasoning_effort` 和可选 `service_tier`。不再从用途绑定直接读取模型字符串。

模型发现使用独立短生命周期 App Server 客户端：初始化、发送 `initialized`、分页调用 `model/list`、取得结果后关闭。模型发现失败不影响正在运行的 Codex 任务。

## API Agent 适配器

### 厂商协议

- OpenAI 使用 Responses API。
- Claude 使用 Messages API。
- DeepSeek 和 GLM 使用各自官方 OpenAI-compatible Chat Completions 接口。

每个适配器负责：鉴权 Header、系统消息位置、推理参数映射、加速参数映射、工具声明、工具调用解析、工具结果回传、停止原因、用量字段和错误分类。

最终结构化结果优先通过名为 `submit_result` 的严格函数工具提交，参数 Schema 就是调用方提供的 `outputSchema`。厂商无法强制最终工具时允许返回 JSON 文本，但必须经过 JSON 解析与 Zod 校验；失败后最多重试三次，不能降低 Schema 要求。

API Agent 最多执行 24 轮模型—工具交互。达到用途超时、收到取消信号或超过轮数时立即终止，不继续计费重试。

### 只读工具代理

新增 `ReadonlyAgentToolBroker`，向 API 模型公开强类型工具而不是生产凭据：

- `search_code`：在当前发布快照中执行限量搜索。
- `read_code`：按受限路径和行数读取代码。
- `read_git`：读取提交、差异和文件历史。
- `server_check`：读取服务状态、系统资源和 Nginx 摘要。
- `read_recent_logs`：按服务器、服务、时间、关键词和行数读取限量日志。
- `database_query`：调用统一数据库只读助手。
- `redis_read`：只允许当前白名单中的只读命令。
- `run_readonly_command`：仅用于现有白名单能够完整解析和验证的代码或远端只读命令。

`trusted-command-observation` 中的命令解析与验证需要拆为可复用的“执行前验证”函数。API 工具请求先验证、再执行、再按相同规则验证观察结果。不能解析的命令不执行。

数据库查询继续满足：

- 只接受单条 `SELECT`、`SHOW`、`DESCRIBE`、`DESC` 或 `EXPLAIN`。
- 限定当前服务数据库和已知业务表。
- 订单查询带订单号和 `LIMIT`。
- 通过绑定服务器内现有 Python MySQL 驱动执行。
- 每次真实查询进入本题临时审计。
- 确定性代码补齐订单主表、`sys_log` 和 `channel_log` 证据门禁。

工具结果先按字段和已配置秘密脱敏，再按固定字节数截断，最后返回模型。API 厂商永远看不到服务器私钥、数据库密码、完整连接配置或 Telegram 凭据。

模型自述但没有真实工具审计的步骤仍被标为推断，不得满足回复或升级证据门禁。

## 技术告警群 `/ai`

技术告警群继续只接受：

```text
/ai <服务> <问题>
```

群编辑弹窗新增“`/ai` 使用模型”，启用技术告警群时必填。命令中的服务仍只用于选择已配置项目服务，不改变群配置本身。

技术命令执行策略：

1. 使用群配置的模型别名，而不是全局回答别名。
2. 使用全局回答用途的超时和并发上限。
3. 同样先同步目标服务双仓共同分支，再进入只读排查。
4. 使用启用的固定安全与排查规则。
5. 不查询 `listAnswerMemories`，传给模型的有效记忆固定为空。
6. 回复记录的 `memoryVersionRefs` 固定为空。
7. 技术命令记录不进入自动学习队列。

技术命令与正式客服共用新的 `StaticSupportKnowledgeResolver`：

- 只有明确询问接口定义、路径、请求参数、返回字段、签名或字段填写方式时，才检索当前服务地区的接口文档。
- 涉及服务地区、交易类型、银行编码、IFSC 或 MagicBook 参数映射时，检索 MagicBook。
- 印度和非印度文档继续严格隔离。
- 静态知识只回答定义和映射，不用于判断真实订单状态、回调结果或责任归属。

普通客服仍按现有规则检索少量有效 AI 记忆；静态知识触发策略与技术命令保持一致。

## 群级回复风格

每个白名单群保存 `reply_style`：

### `human`

保持当前运营群行为：

- 默认一到两行。
- 自然群聊口语。
- 减少技术词和报告腔。
- 执行 `operatorCopy`、`operatorVoice`、过度技术表达检测和重答。
- 保留当前标点和常用措辞要求。

### `unrestricted`

表示直接使用 AI 通过结果 Schema 后的 `answer`：

- 不注入真人口吻、篇幅、标点、报告腔或技术词限制。
- 不调用口吻改写。
- 不因“太技术”触发重答。
- 允许模型自行决定段落、Markdown、术语和长度。

`unrestricted` 只关闭风格限制，不关闭以下固定边界：

- 服务隔离和代码优先级。
- 生产环境只读。
- 必查证据与调查审计。
- 只有当前代码明确缺陷才允许升级。
- 出站敏感信息拦截。
- 结构化结果校验。

现有“运营群自然回复”固定规则改为条件式风格策略，只在 `reply_style=human` 时注入。其他固定规则不受影响。

## 后台信息架构

主菜单中的“模型与运行”拆为：

- `模型管理`
- `运行配置`

### 模型管理

页面首屏为模型别名列表，显示：

- 别名
- 厂商
- 接入方式
- 真实模型
- 推理强度
- 加速模式
- 密钥状态
- 启用状态
- 最近检测状态和时间
- 被回答、记忆或技术群引用的位置

支持新增、编辑、检测、停用和删除。新增或编辑弹窗按以下顺序逐步显示字段：

1. 别名。
2. 厂商。
3. 接入方式。
4. 模型目录选择或自定义模型 ID。
5. 当前模型支持的推理强度。
6. 当前接入支持的加速模式。
7. 当前模型支持的其他参数。
8. API 密钥或 Codex 登录状态。

切换厂商、接入方式或模型时重新计算能力，不保留已经不兼容的隐藏值。保存前明确展示被清除的参数。

连接检测使用无业务数据的最小结构化请求。Codex CLI 还检查本机命令和登录状态。API 检测区分鉴权失败、余额或限流、模型不存在、参数错误和服务不可用。

### 运行配置

页面顶部为回答与记忆用途卡片：

- 从已启用模型别名中选择。
- 显示厂商、接入方式、真实模型、推理和加速摘要。
- 分别配置用途启用、超时和并发。

原有自动客服开关、消息等待、进度通知、自动学习、手动代码同步、手动学习和运行状态保留。Codex 检测改成“模型运行检测”，并分别汇总当前回答、记忆和技术命令模型的可用性。

### 白名单群

群编辑弹窗增加：

- “真人回复风格”开关，所有白名单群都可配置。
- 技术告警群显示“`/ai` 使用模型”并要求选择别名。
- 技术告警群显示“不读取 AI 记忆；接口文档和 MagicBook 按正式规则检索”的说明。

群列表直接显示“真人口吻”或“AI 原始回复”。技术告警群额外显示模型别名。

所有新增页面、弹窗和状态必须验证浅色、深色、桌面宽度、受限高度和窄屏抽屉，不产生横向溢出。

## 运行与错误行为

模型配置变化只影响新任务。运行用途和群引用通过外键阻止删除；无静态引用但仍有运行中快照的模型，由 `ModelGateway` 活跃执行注册表阻止删除。停用配置不会中断已经启动的快照任务。

系统不做静默模型回退。原因是不同厂商的工具能力、数据出境范围、计费和回答质量不同，自动切换会改变用户明确配置。失败时：

- 普通客服按当前回答超时规则发送诚实兜底。
- 技术群命令回复脱敏的模型不可用说明。
- 系统运行故障继续发送独立技术告警。
- 后台状态标记具体模型别名和错误分类。

普通日志只记录模型实例 ID、厂商、接入方式、耗时、工具次数、结果状态和错误分类，不记录提示词、厂商原始响应、工具完整输出、API 密钥或生产连接信息。

## 验证策略

项目约束禁止提交新增测试文件或测试代码。本次开发可以使用临时 TDD 文件或一次性脚本验证行为，但必须在每个提交前删除。最终提交只保留生产代码和文档。

必须完成：

1. 合并发布时先执行版本 12 到 13 的对话取消迁移，再执行版本 13 到 14 的模型迁移；同时兼容开发期已占用 v13 的模型库，验证默认回答和记忆别名及用途绑定保持原值。
2. 迁移库导出后验证不包含模型 API 密钥，导入后 API 模型为未配置状态且别名引用保留。
3. Codex App Server 动态模型发现，确认 Luna、GPT-5.5 及其他当前可用模型出现，推理档位随模型变化。
4. 四个厂商适配器的结构化输出、错误分类、取消、超时和 24 轮工具上限。
5. API 回答模型实际完成代码、SSH、数据库和 Redis 只读工具调用，并形成可信审计。
6. 模型伪造工具执行时不通过证据门禁。
7. 回答、记忆和技术群分别选择不同别名后使用正确实例快照。
8. 技术群不检索或引用 AI 记忆，不进入自动学习，同时能按触发规则获得接口文档和 MagicBook。
9. `human` 与 `unrestricted` 两种回复路径，确认关闭风格后不再执行口吻重写和技术词重试，但 DLP 与证据门禁仍生效。
10. 已引用别名删除保护、模型停用、密钥缺失和运行中配置变更。
11. `pnpm test`、`pnpm typecheck`、`pnpm build` 和 `git diff --check`。
12. 浅色、深色、桌面和窄屏真实页面检查；浏览器控制台无错误。

本机不安装、启动或重启客服常驻服务，也不以本机健康检查作为上线结论。最终部署和线上验收只在用户指定的 Linux 部署服务器执行。

## 不在本次范围

- 自动模型故障切换或成本路由。
- 任意 OpenAI-compatible 自定义厂商。
- 任意自定义 API Base URL。
- 模型计费统计和预算控制。
- 文本嵌入、语音和图像生成模型。
- 修改生产服务器权限、部署、数据库或 Redis 数据。

## 验收标准

1. 管理员可以创建 ChatGPT / OpenAI、DeepSeek、Claude 和 GLM 模型别名，API 密钥安全保存且可检测。
2. Codex CLI 模型列表不再硬编码，当前完整目录中的 Luna、GPT-5.5 等模型可选，并只展示各自支持的参数。
3. 运行配置通过模型别名独立选择回答和记忆模型，旧配置自动迁移且行为不变。
4. 任一通过能力检测的 API 模型都能作为正式回答模型执行受控只读排查并产生可审计结构化结果。
5. 技术告警群可以独立选模，`/ai` 不使用 AI 记忆，但按正式规则使用当前代码、接口文档和 MagicBook。
6. 每个白名单群可以独立选择真人口吻或不受风格限制的 AI 原始回复。
7. 无论模型厂商和回复风格如何，生产只读、敏感信息、服务隔离、证据和升级规则均不可绕过。
