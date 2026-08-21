# 证据收集—独立成稿—质量审核设计

## 目标

解决调查模型同时查资源、判断责任和写客服文案时容易出现的注意力竞争：事实虽然查到了，最终回复却可能漏掉“这是给谁发的”、我方证据或准确核对事项。新链路必须保留当前单阶段回答作为同轮基线；任何新增阶段失败、越权或被审核判定退步时，最终结果回退基线。

## 成熟项目做法与取舍

- Anthropic 的 [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) 建议固定、可拆分任务优先用 prompt chaining，并在步骤之间设置检查门。
- OpenAI Agents SDK 的 [Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/) 支持由代码编排多个独立 Agent、使用结构化输出交接，并通过 evaluator loop 改进结果。
- LangGraph 的 [Workflows and agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents) 将 orchestrator-worker、evaluator-optimizer 作为明确工作流模式。
- AutoGen 的 [Reflection](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/reflection.html) 强调生成者和审核者分离，并设置明确停止条件。
- Anthropic 的 [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) 强调给下一阶段最小、高信号上下文。

本项目采用固定代码编排，不建设开放式多 Agent 自主路由。原因是客服决策、只读资源权限、升级类型和 Telegram 投递状态必须由宿主程序稳定控制。

## 流水线

1. 调查模型沿用当前全部提示词和只读工具，输出完整 `AnswerDecision` 作为基线，同时输出 `EvidencePacket v1`。
2. 父进程使用现有命令观察验证、数据库二次复核和脱敏逻辑重建可信排查轨迹，只把有可信来源支持的事实交给下一阶段。
3. 独立成稿模型使用全新上下文和 `text-only` 权限；它没有文件、代码、服务器、数据库和网络能力，只能使用证据包中允许出站的事实。
4. 审核模型比较新候选和当前基线。它可以批准、要求重写一次或直接选择基线。
5. 第二次审核仍未批准、任一新增阶段失败、事实引用无效或触发 DLP 时，使用调查模型基线。
6. 最终结果继续经过现有出站 DLP、线程版本、升级投递、Telegram ownership 和发送状态机。

## 权责边界

- `decision`、`escalationType`、`humanOperation`、`responsibility`、`interaction` 只由调查阶段决定，成稿模型不可修改。
- 事实使用 `F1`—`F24` 稳定 ID。成稿结果必须逐条引用事实 ID，声明文本必须逐字出现在正文。
- 父进程只执行来源存在性、引用完整性、结构、权限、脱敏和投递状态等确定性检查，不用业务关键词或分数裁决责任与业务语义。
- `copyable_message` 必须有接收方、独立可复制正文、我方可复核证据和准确核对事项。
- `outboundSafe=false` 的内部路径、连接信息、完整报文、密钥签名和无关技术细节不得进入成稿。

## 审计与回归门禁

SQLite `reply_generation_audits` 保存脱敏后的证据包、基线、首次候选、重写候选、审核结果、最终来源和回退原因。回归使用同一数据库中的历史客服记录和后台聊天：全量做结构与安全检查，分层抽样做真实模型回放。只有现有测试、历史回放、类型检查、构建和生产前候选验收均无未解释退步时才允许切换。

## 2026-08-22 回归结果

- 当前生产 SQLite 可评测语料为 193 条客服群完成记录、115 条后台完成记录，其中客服人工纠正 16 条、后台人工纠正 2 条。
- 分层混合回放 15 条：客服群 9 条、后台 6 条、人工纠正 5 条、带附件 2 条。15 条全部执行成功，明确退化 0 条，独立裁判 15 条均偏好新结果。
- 流水线最终采用首次成稿 9 条、审核后重写稿 1 条、当前版本基线 5 条；审核主动回退证明新增阶段失败或变差时不会覆盖基线。
- 首轮发现 1 条代码条件表达略绝对但尚未构成相对历史退化，补充“开关、状态、分支、时间范围和前置条件不得丢失”的通用规则后，针对同一带附件长尾样本复测通过，六个质量维度全部改善且无剩余问题。
- 首次生产争议场景验收发现回复虽然结论正确，但带入了对方无法独立复核的报文哈希和字节数；因此进一步要求证据收集阶段默认将无关诊断元数据标为不可出站，成稿与审核阶段只保留对方明确索要或确实能帮助定位的关联标识。
- 混合回放连同独立回归裁判的端到端耗时为最短 40.9 秒、中位 142.5 秒、P90 378.6 秒、最长 448.2 秒；其中包含生产不会执行的独立裁判调用，不能直接当作运营回复时延。
