# 同群角色用户人工接管设计

## 目标

后台“群与账号 > 用户与角色”中已启用的角色用户，在客服群里回复某个仍处于等待、排队或生成阶段的问题时，系统立即关闭该问题并停止后续机器人回复。

本次设计固定以下边界：

- 人工消息和目标问题必须属于同一个 Telegram 群。
- 人工消息必须能够唯一关联到目标问题；无法唯一确认时不关闭任何问题。
- `是否作为学习来源` 只控制后续 AI 学习，不控制人工接管资格。
- 已经进入 Telegram 发送阶段或已经发送成功的消息不删除、不撤回。
- 已回答、已升级或已关闭的问题不因后续人工消息改变终态。
- 角色用户普通消息继续只留审计，不写入问题正文，不延长问题等待窗口，也不触发新的客服回答。

## 当前实现与缺口

项目已经具备大部分底层能力：

- `SupportThreadLifecycleService.takeOverFromHuman` 可以在 SQLite 事务中关闭线程并作废尚未发送的回复。
- `SupportAnswerWorker.cancel` 可以通过 `AbortController` 中止回答链路；Codex CLI 和只读子进程会终止整个进程组。
- 回答工作器在取得 Telegram 发送所有权前会再次检查线程版本，人工接管先完成时不会调用发送器。
- `telegram_output_ownership` 已能区分尚未发送、正在发送、发送成功、发送失败和发送结果未知。
- 现有线程关联已覆盖原问题、机器人回复、回复链和唯一活跃线程，并已有跨群隔离测试。

缺口位于入口职责：`LearningSourceObserver` 同时负责“人工接管”和“人工回复学习”，并要求角色的 `learning_source_enabled=1`。因此后台显示“不学习”的已启用用户虽然普通消息会以 `role_skipped` 落库，却不会触发人工接管。

本次不重写已有线程状态机和发送所有权机制，而是拆开接管资格与学习资格，复用已经验证的关闭、取消和并发保护。

## 成熟方案调研

Chatwoot 的机器人转人工会在会话状态切换时清除机器人分配，并在锁内完成新的人工分配。可复用结论是：人工接管应当是一个明确、持久且原子的会话状态变化，不能只停止前端动画或依赖内存标志。

Rasa 把 human handoff 作为会中断当前自动流程的通用会话模式；流式动作被打断时还会取消正在运行的输出流。可复用结论是：接管完成后既要改变持久状态，也要向仍在运行的生成链发送取消信号。

Telegram `Message.reply_to_message` 只表示同一 chat 和同一 message thread 内的被回复消息。可复用结论是：直接回复关系是最高可信关联，但数据库查询仍必须使用 `group_id + telegram_message_id` 组合，不能只按消息 ID 或服务关联。

参考：

- https://github.com/chatwoot/chatwoot/blob/develop/app/controllers/api/v1/accounts/conversations_controller.rb
- https://rasa.com/docs/reference/primitives/patterns/
- https://core.telegram.org/bots/api#message

## 方案比较

### 方案 A：扩大现有学习观察器的授权范围

移除 `LearningSourceObserver` 对 `learning_source_enabled` 的判断，让所有已启用角色都写入学习观察并接管。

改动最少，但会把“不学习”的角色消息写进学习队列，必须再通过额外状态阻止学习，继续混淆“接管”和“学习”两个不同产品概念，因此不采用。

### 方案 B：独立人工接管服务，学习作为可选后续步骤

新增独立人工接管服务处理所有已启用角色的 `role_skipped` 消息。服务先在同群范围内关联线程并完成接管，再根据角色的 `learning_source_enabled` 决定是否创建学习观察。

这是采用方案。它保留现有可靠的线程关闭和取消机制，明确区分接管权限与学习权限，并能为“不学习”的人工接管留下独立审计。

### 方案 C：角色消息关闭同群全部活跃问题

任意已启用角色在群里发送普通消息时，关闭该群所有活跃问题。

实现简单，但同一群可能同时处理多个互不相关的问题，普通沟通会误关其他问题，不符合“回复这个问题”的要求，因此不采用。

## 角色与群资格

人工接管入口只接受同时满足以下条件的消息：

1. 消息不是机器人消息。
2. 来源群已启用，群用途为 `support`，且绑定有效项目和服务。
3. 发送人的 Telegram 数字用户 ID 与一条已启用角色记录精确相等。
4. 普通消息路由结果为 `role_skipped`；`/ai` 和 `/correct` 继续走各自命令链路，不触发本设计的普通人工接管。

用户名、显示名、群管理员身份和消息文本都不能替代数字用户 ID 授权。已停用角色不具备接管资格。

`learning_source_enabled` 不参与以上资格判断。它只在接管关联完成后决定是否把人工消息交给学习链路。

## 同群与线程关联

关联器必须先固定人工消息的 `event.group_id`，所有查询都以该群为硬条件。目标线程还必须属于该群当前绑定的服务。相同服务、相同文本、相同订单号或相同消息数字 ID 都不能跨群关联。

关联顺序固定为：

1. **直接回复原问题**：回复目标是同群 `support_message_events`，且该事件在目标线程中是原问题。
2. **直接回复机器人输出**：回复目标是同群 `telegram_output_ownership`、客服最终回复或进度通知所拥有的消息。
3. **回复链**：沿同群消息的 `reply_to_message_id` 向上查找，最多 32 层，命中原问题、机器人输出或已记录的人工接管消息即停止。
4. **唯一活跃线程**：人工消息没有回复目标时，只在同群、同服务、30 分钟有效期内恰好存在一个非终态问题时关联。

以下情况不关闭问题：

- 回复目标来自其他群。
- 同群存在两个或更多活跃问题且消息没有明确回复关系。
- 回复链无法关联到当前群的问题。
- 目标问题已经过 30 分钟归档边界。
- 目标问题已经是 `answered`、`escalated` 或 `closed`。

角色消息自身继续保存在 `support_message_events`，但不加入 `support_thread_messages`，避免把人工回答当作运营补充再次交给 AI。

## 状态变化与并发边界

### 可以被接管的阶段

人工接管会关闭仍在处理中的线程；尚未取得 Telegram 发送所有权的回复会被阻止，已经取得发送所有权的回复允许完成：

| 问题/回复阶段 | 人工接管结果 |
| --- | --- |
| `collecting`，尚在 30 秒等待 | 线程关闭，不再被工作器领取 |
| 已领取但回复仍为 `pending` 或 `queued` | 回复作废，线程关闭 |
| `generating` | 回复作废，线程关闭，并中止当前生成和只读排查 |
| 已准备内容但尚未成功 `claimSending` | 最终发送 CAS 失败，不调用 Telegram |
| 已进入 `sending` | 线程关闭并记录 `delivery_in_flight`，现有发送允许完成，不删除、不撤回 |
| 已发送或线程已终态 | 不改变原终态，记录 `thread_already_terminal` |

这里的唯一竞态裁决点是持久发送所有权：人工接管事务先完成，则发送方无法取得所有权；发送方已经取得所有权，则本次消息视为已经开始发送。系统不尝试取消 Telegram RPC，也不在发送完成后删除消息。

### 原子关闭

`SupportThreadStore` 在一个 SQLite 事务中完成：

1. 重新读取目标线程并确认群、服务、状态和输入版本仍符合接管条件。
2. 检查客服回复、技术告警、进度通知和统一输出所有权是否已经处于 `sending`。
3. 把 `pending`、`queued`、`generating` 回复改为 `superseded`。
4. 取消尚未开始的进度通知；发送中的通知按现有规则标记结果未知，不重发。
5. 把线程更新为 `closed`，写入接管人、接管时间和明确关闭原因。
6. 写入人工接管审计记录。

事务提交后，`SupportThreadLifecycleService` 调用回答工作器的 `cancel(threadId)`。取消信号贯穿 Codex CLI、直接 API、SSH、数据库只读助手和其他只读工具。重复收到同一 Telegram update 时返回既有审计结果，不重复关闭或学习。

## 审计数据

SQLite schema 从 23 升到 24，新增追加式 `support_human_takeovers`：

- `id`
- `message_event_id`，唯一并关联人工消息事件
- `group_id`
- `thread_id`，无法关联时允许为空
- `source_telegram_user_id`
- `source_role`
- `association_reason`
- `association_confidence`
- `takeover_status`
- `created_at`

`association_reason` 继续使用 `direct_question`、`direct_bot_reply`、`reply_chain`、`single_active_thread`、`ambiguous` 和 `none`。`takeover_status` 使用 `cancelled`、`delivery_in_flight`、`thread_already_terminal`、`ambiguous` 和 `not_linked`。

证据字段禁止普通 UPDATE 和 DELETE。表结构必须包含按 `message_event_id` 的唯一约束、按 `thread_id + created_at` 的详情索引，以及按 `group_id + created_at` 的审计索引。迁移库和导入恢复必须包含该表。

现有 `learning_source_observations` 继续只保存允许学习的角色消息。它引用同一次关联结果，不再负责关闭线程。这样“不学习”的角色会产生人工接管审计，但不会进入学习观察、参考整理或风格提取。

## 组件职责

### `HumanTakeoverService`

- 接收已落库的 `role_skipped` 事件和已授权角色快照。
- 在同群范围内完成线程关联。
- 调用生命周期服务执行原子接管。
- 无论关联成功、歧义或未关联，都幂等保存接管审计。
- 返回结构化关联和接管结果供可选学习步骤使用。

### `LearningSourceObserver`

- 不再决定是否接管，也不再重复执行线程关联。
- 只在角色启用 `learning_source_enabled` 时，把接管服务返回的关联结果转换为现有学习观察。
- 非学习角色、歧义关联和无法关联不会进入学习队列。

### `SupportThreadCoordinator`

- 角色普通消息落库后先调用 `HumanTakeoverService`。
- 接管结果表明角色允许学习时，再调用 `LearningSourceObserver`。
- 角色消息始终在该分支结束，不进入普通问题批次和 30 秒等待。

### `SupportThreadLifecycleService` 与 `SupportThreadStore`

- 继续作为所有关闭入口的统一状态机。
- 接管事务同时写线程状态、回复作废状态和接管审计。
- 事务提交后再取消进程，避免数据库回滚但进程已经被不可逆终止。

## 后台展示

“用户与角色”不新增接管开关。已启用角色默认具备同群人工接管能力；“学习来源/不学习”只表达是否用于 AI 学习。

角色编辑区域增加简短说明：

```text
已启用用户在同群回复客服问题时会接管并停止 AI 处理
学习来源只控制是否用于 AI 学习
```

客服记录详情在关闭审计区显示：

```text
角色用户 yang 回复后人工接管
```

详情同时展示关联方式。歧义和未关联审计只在后台留痕，不向 Telegram 群发送任何机器人说明。

## 错误处理与恢复

- 接管审计写入失败时，线程关闭和回复作废整体回滚，避免出现无审计接管。
- SQLite 事务提交后进程取消失败时，线程持久状态仍为关闭；工作器的当前版本门禁保证后续阶段不发送。
- 服务重启不会重新打开已被人工接管的线程，也不会恢复其 `superseded` 回复。
- 已处于 `sending` 的输出继续沿 `telegram_output_ownership` 现有恢复规则变成 `sent`、`failed` 或 `unknown`，不执行删除，也不盲目重发。
- 个人账号手工发送的 outgoing 事件继续通过统一输出所有权识别：应用自产消息跳过，无法匹配为应用输出的手工消息正常进入角色接管判断。
- Bot 或个人账号断线期间不能承诺即时接管；连接恢复收到事件后仍按消息原始群和目标关系处理，终态问题不会被再次关闭。

## 验证

永久回归测试至少覆盖：

1. 已启用且“不学习”的角色直接回复原问题时关闭 `collecting` 线程，但不创建学习观察。
2. 已启用且允许学习的角色完成相同接管，并只创建一条学习观察。
3. 已停用角色、用户名冒充和非数字 ID 不具备接管资格。
4. 相同服务的两个群中，角色回复只能关闭消息所在群的线程。
5. 跨群机器人消息 ID、回复行群不一致和跨群回复链全部拒绝关联。
6. 同群多活跃线程且没有明确回复关系时记录 `ambiguous`，不关闭任何线程。
7. 同群只有一个活跃线程且没有回复目标时可以接管。
8. 直接原问题、直接机器人输出、进度通知和回复链按固定优先级关联。
9. `collecting`、`pending`、`queued`、`generating` 接管后都不会调用 Telegram sender。
10. 生成中接管会触发 `AbortController` 并终止 Codex/只读工具执行。
11. 发送 CAS 前接管时发送失败；已经 `sending` 时只记录 `delivery_in_flight`，发送完成后不删除。
12. 已回答、已升级和已关闭线程保持原终态。
13. 重复 update、并发 SQLite 连接和服务重启场景保持幂等。
14. schema 23 升级到 24、完整迁移库导出导入和旧迁移谱系均保留接管审计。
15. 客服记录和用户角色说明在浅色、深色、桌面和窄屏下无溢出。
16. 使用 Node.js 22.16+ 运行相关 Vitest、完整测试、`pnpm typecheck` 和 `pnpm build`。

本地代码编辑与测试不能作为上线结论。最终发布仍只在用户指定的 Linux 部署服务器完成，由 systemd 托管并验证 `127.0.0.1:3210` 健康检查。
