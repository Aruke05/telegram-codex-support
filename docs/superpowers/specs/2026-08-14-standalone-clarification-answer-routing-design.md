# 裸短答案续接问题线程设计

## 背景

LakPay 群中出现了以下真实链路：

1. 运营发送“创建一个新的运营账号”。
2. 客服回复“新账号要用的用户名发我一下”。
3. 同一运营直接发送 `kakaxi`，没有使用 Telegram 回复功能。
4. 消息已被 Telegram 接收并写入 `support_message_events`，但路由模型把孤立短文本判断为无需客服介入，写成 `ignored`。
5. 另一位运营随后回复客服消息并再次发送 `kakaxi`，因为存在 `reply_to_message_id`，才被确定性续接到原线程。

根因不是消息接收失败，而是现有确定性路由只识别 Telegram 显式回复关系。候选线程交给模型时只包含摘要和状态，不包含原发送人、最近客服追问以及“正在等待最少信息”的明确状态，导致账号名、订单号等裸短答案可能被当成闲聊。

## 成熟方案参考

- Telegram 官方把 `reply_to_message` / `reply_to_msg_id` 作为消息回复关系的权威标识，因此本项目继续把显式回复放在最高优先级。[Telegram Bot API](https://core.telegram.org/bots/api) [Telegram message threads](https://core.telegram.org/api/threads)
- Chatwoot 使用稳定的 conversation 聚合消息，并以 `last_activity_at` 等字段维护会话活动，而不是对每条消息重新建立无上下文意图。[Chatwoot conversation model](https://github.com/chatwoot/chatwoot/blob/develop/app/models/conversation.rb)
- Zammad 将后续 article 归入已有 ticket，并保留 `in_reply_to`、`message_id` 等关系；这说明显式关系优先、稳定工单上下文兜底是成熟客服系统的常见做法。[Zammad ticket model](https://github.com/zammad/zammad/blob/develop/app/models/ticket.rb)

本项目不直接照搬长生命周期工单模型。客服线程仍按 30 分钟归档，兜底只用于机器人刚完成最少信息追问后的唯一可关联线程。

## 目标

- 同一发送人直接发送账号名、订单号或其他短答案时，可以续接机器人刚追问的原线程。
- 不要求运营必须点击 Telegram 的回复按钮。
- 不把不同运营的裸消息或存在多个歧义候选时的消息强行串入某个线程。
- 保留显式回复、批次恢复、异常兜底和现有模型路由的优先级与行为。

## 方案

在 `ThreadStore` 增加一个只读查询，用于查找“唯一待当前发送人补充”的线程。`ThreadCoordinator` 在显式回复匹配失败后、调用模型路由前执行该查询。

候选必须同时满足：

1. 同一群、同一绑定服务。
2. 线程未关闭且未超过现有 30 分钟归档边界。
3. 原问题发送人与当前消息发送人相同。
4. 线程最近一次最终客服结果是 `reply`，且策略为 `minimal_clarification`。
5. 最近客服回复已真实发送成功。
6. 该发送人在当前范围内只有一个符合条件的线程。
7. 新消息没有显式回复关系；有显式回复时始终使用现有精确路径。

命中唯一线程后，整批消息按 `reopen` 或 `supplement` 追加，复用现有 30 秒滑动窗口、版本递增、旧结果作废和回答生成流程。未命中或出现多个候选时继续使用现有模型路由，不静默丢弃，也不猜测目标线程。

## 数据与接口

- 不新增表、不修改 SQLite schema。
- 使用现有 `support_threads`、`support_thread_messages`、`support_message_events`、`support_replies` 和 `telegram_output_ownership` 查询。
- 不增加可配置时间窗口；直接复用线程 30 分钟有效边界，避免产生第二套生命周期规则。
- 不根据短文本格式硬编码用户名或订单号正则。是否属于补充由“唯一等待该发送人补充的线程”状态决定。

## 安全与歧义处理

- 不跨群、不跨服务、不跨发送人关联。
- 多个待补充线程时拒绝确定性吸附，交回模型路由。
- 已关闭或已归档线程永不续接。
- 延迟到达的旧消息按当前处理时间判断归档，不能用消息时间复活已过期线程。
- 技术角色、角色白名单、命令和 Telegram 显式回复规则保持不变。
- 本次不处理技术告警 `unknown` 投递问题，避免把消息路由修复与 Telegram 写入恢复混在同一个变更中。

## 测试

新增回归用例覆盖：

1. 同一发送人在机器人 `minimal_clarification` 成功发送后直接发送 `kakaxi`，应续接原线程且不调用模型路由。
2. 不同发送人的裸短文本不能被自动续接。
3. 同一发送人存在两个有效待补充线程时不能确定性续接。
4. 最近结果不是 `minimal_clarification`、回复未成功发送、线程已关闭或已过期时不能续接。
5. 带 `reply_to_message_id` 的消息继续走现有精确关联路径。

完成后运行相关测试、全量测试、类型检查和生产构建；只在用户确认后推送并部署到既有 Linux systemd 服务。
