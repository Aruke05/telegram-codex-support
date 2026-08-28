# 客服线程语义输出所有权设计

## 目标

修复 EZPay 真实会话暴露的三个连续问题：已经转技术的线程被后续短消息重新打开、同一线程重复发送转技术收口、多个进度入口各自发送“稍等”。修复后必须满足：

- 同一线程最多只有一个进度确认所有者。
- 同一线程最多只有一个人工接管或技术升级所有者。
- 已经进入人工接管的线程仍可追加运营消息用于审计，但不增加输入版本、不唤醒回答模型、不再次发送运营回复或技术告警。
- 单独数字、符号或其他语义不完整消息由路由模型结合完整群聊时间线判断；代码只执行结构化状态门禁，不使用关键词、正则、相似度或分数裁决业务语义。
- 独立的新业务问题仍能建立新线程。

## 事故事实与根因

EZPay 线上记录中先后出现了一条冗长进度回复和两条相同的“这边没处理完，我帮你转给技术继续跟进”。第一条单独的 `1` 出现在第二条收口之后，系统仍把它路由成 `reopen` 并启动新一轮生成；第二条 `1` 又作为补充进入另一个线程。

当前实现的根因是：

1. `SupportThreadStore.appendMessage` 会把 `escalated` 线程重新改成 `collecting` 并增加 revision。
2. `finalizeRejectedGeneration` 只检查线程历史上是否发送过进度；每个新 revision 都能准备一条新的技术升级回复。
3. `support_reply_alert_deliveries` 只按 reply 去重，新 revision 会产生新 reply，因此无法提供线程级 exactly-once。
4. 状态催促、定时进度和人工优先等待使用不同的领取入口，没有共同的线程级 CAS。
5. 路由模型没有获得近期机器人输出、线程终态和人工接管状态；路由失败还会默认创建新线程。

## 成熟方案调研

- LangGraph 官方文档把线程 checkpoint 作为 human-in-the-loop 和故障恢复的基础；中断前的副作用必须幂等，恢复必须继续使用同一个 thread ID。
- Temporal 的 Durable Execution 与 AI reference architecture 同样把人工等待建模为持久工作流状态，并要求网络 Activity 在重试时保持幂等。
- SQLite 官方文档保证单写事务的原子性，唯一约束配合 `INSERT ... ON CONFLICT DO NOTHING` 可以作为本项目单机 SQLite 下的 CAS。

可复用结论是“语义动作先持久领取，网络发送再沿既有 delivery ownership 执行”。本项目不引入 LangGraph 或 Temporal：现有 SQLite 状态机和 `telegram_output_ownership` 已具备网络副作用审计，只缺少线程语义级唯一领取。

参考：

- https://docs.langchain.com/oss/python/langgraph/persistence
- https://docs.langchain.com/oss/python/langgraph/interrupts
- https://go.temporal.io/platform-hub/ai-engineering/ai-reference-architecture
- https://www.sqlite.org/lang_transaction.html
- https://www.sqlite.org/lang_upsert.html

## 数据模型

数据库版本从 32 升到 33，新增 `support_thread_output_claims`：

```sql
CREATE TABLE support_thread_output_claims (
  thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  claim_kind TEXT NOT NULL CHECK(claim_kind IN ('progress','handoff')),
  source_kind TEXT NOT NULL CHECK(source_kind IN (
    'scheduled_progress','status_request','human_priority',
    'code_defect','technical_change','feature_request','service_handoff','human_operation',
    'failure_after_progress','hard_deadline'
  )),
  reply_id TEXT REFERENCES support_replies(id) ON DELETE CASCADE,
  notification_id TEXT REFERENCES support_thread_notifications(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(thread_id,claim_kind),
  UNIQUE(reply_id),
  UNIQUE(notification_id),
  CHECK(
    (claim_kind='progress' AND reply_id IS NULL AND notification_id IS NOT NULL)
    OR
    (claim_kind='handoff' AND reply_id IS NOT NULL AND notification_id IS NULL)
  )
);
```

领取表只表达“这个线程的这类语义输出由谁负责”，不复制实际发送状态：

- progress 的发送状态继续由 `support_thread_notifications` 和 `telegram_output_ownership` 负责。
- handoff 的准备、告警和运营回复状态继续由 `support_replies`、`support_reply_alert_deliveries` 和 `telegram_output_ownership` 负责。
- `sending`、`sent`、`unknown` 或已经得到 Telegram message ID 的输出都视为已经开始，绝不换所有者。
- 明确失败且没有开始 Telegram RPC 的 progress notification 可以释放领取，让同一线程的最新有效版本重新领取；释放必须校验 owner ID，不能删除其他路径的领取。

领取表进入完整迁移 SQLite、敏感信息扫描、导入导出和清空顺序。迁移按实际表、列、约束和索引能力校验，不只相信 `schema_version`。

### v32 历史状态回填

v32→v33 不能只建空表，否则升级前已经发送过进度或已经升级的线程会失去语义锁。迁移必须在同一事务内回填：

- progress 优先绑定现有 `kind='progress'` notification；只有 human priority 或 status request 旧链路没有 notification 时，才创建一条合成 progress notification，并把同线程已有的 progress Telegram ownership 补上该 notification ID。
- 合成 notification 的状态只根据结构化发送事实确定：Telegram ownership 为 `sent` 时写 `sent`，为 `sending/unknown` 时写 `unknown`；只存在 `human_priority_progress_message_id` 时写 `sent`。不得解析客服文案。
- handoff 从 `decision='escalate'` 的既有 reply 中选取最早已经准备、告警、开始发送或进入终态的一条作为 owner。`feature_request_prepared` 和 `answer_hard_deadline` 使用对应 source；其他无法从结构化字段还原的旧升级统一标成 `technical_change`，不猜原始业务类型。
- 同一线程历史上已有重复升级时只回填最早 owner，后续重复 reply 和 delivery 继续作为不可变历史保留，但不再拥有发送资格。
- 回填生成的 UUID 与时间必须通过当前严格 schema；任何外键、唯一性或结构不一致使整个迁移回滚。

## 统一进度链路

定时进度、人工优先等待结束和真正的状态催促全部先创建或复用一条 `progress` notification，再原子领取 `(thread_id,'progress')`：

1. 事务内创建 notification，并用 notification ID 插入领取表。
2. 插入成功的路径获得发送资格；冲突路径只更新自身审计状态，不发送。
3. 发送前把 notification 从 `pending` CAS 到 `sending`。
4. Telegram 输出继续携带 `notificationId` 和 thread ownership。
5. 成功写 `sent`；结果未知写 `unknown`；明确失败写 `failed` 并在确认没有发送中、成功或未知 ownership 时释放领取。

状态催促不再使用模型生成的长篇进度话术，统一发送经真人口吻 profile 处理的 `operatorCopy.progress`，当前固定正文为“稍等”。路由模型只判断是不是状态催促，不负责生成发送文案。

服务重启后：

- pending notification 重新进入领取队列。
- sending 且已有发送 ownership 的 notification 变为 unknown，不重发。
- sending 且没有开始 Telegram RPC 的 notification 恢复 pending，沿同一 notification 重试。

## 人工接管与终态门禁

回答链准备任何 `decision='escalate'` 的客服回复时，必须在同一 SQLite 事务中领取 `(thread_id,'handoff')` 并绑定当前 reply：

- 同一个 reply 在崩溃恢复时可继续发送。
- 另一个 reply 无法取得该线程的 handoff，必须结束为 superseded/failed，不能再投递技术告警或运营收口。
- hard deadline 和“已发稍等后的失败收口”也走同一领取原语。

一旦线程存在 handoff claim，路由和存储层共同执行终态保护：

- `appendMessage` 不允许把该线程改回 `collecting`。
- 同一事项的 `follow_up` 通过 `appendAuditMessage` 只追加原始事件和更新时间，revision、status、generation 字段保持不变。
- `getSenderFocus` 可以继续返回这个线程，目的是让模型看到已接管语境；候选和上下文必须包含线程状态及 handoff source。
- 路由确认是完整独立的新问题时才创建新线程。

## 路由上下文与失败策略

路由输入增加最近 30 条同群、同服务时间线，包含运营消息、配置角色、机器人已发送回复、reply_to、关联 thread ID 和时间。焦点上下文增加 `status` 与 `handoffSource`。

结构化路由增加 `messageIntent`：

- `actionable`：完整问题、补充事实、必要标识或操作要求。
- `progress_request`：只询问处理进度且没有新增排查信息。
- `non_actionable`：感谢、确认或无需客服介入的沟通。
- `unclear`：无法可靠读出完整意图。

`new_thread`、`split`、`follow_up + changes_input` 只接受 `actionable`；`follow_up + status_only` 只接受 `progress_request`；`idle` 接受 `non_actionable/unclear`；`uncertain` 只接受 `unclear`。这些语义由模型输出并经 schema 校验，代码不检查 `1` 或其他关键词。

协调器使用穷尽分支：

- `new_thread`、`split` 才创建线程。
- `follow_up` 只追加到活跃线程；handoff 线程只审计。
- `idle` 只记 ignored。
- `uncertain` 只有两个有效候选并带自然澄清时才发送；否则静默记录 ignored。
- `candidate_1/2` 只在待确认模式生效。
- 路由失败自动重试一次，仍失败后记录 ignored 和具体错误，不得默认新建线程。

## 角色边界

技术和忽略用户仍只按后台启用的准确 Telegram 数字 user ID 识别。不得根据用户名、显示名或发言内容推断角色。本次测试保留“已配置技术回复后人工接管且机器人零输出”，不增加自动授权逻辑。

## 验收

使用脱敏后的 EZPay 顺序回放：

1. 原问题开始处理并发送一次“稍等”。
2. 失败后只准备并发送一次技术 handoff。
3. handoff 后的业务补充只追加审计。
4. 连续两个 `1` 都不增加 revision、不唤醒模型、不产生运营回复或技术告警。
5. 新的完整独立问题仍创建新线程。
6. 三个进度来源并发时只有一个 notification/claim 和一次 Telegram send。
7. 重启及 unknown delivery 不重复发送。
8. schema 32→33、运行库、迁移库、导入导出和已知旧谱系均通过验证。
9. 带历史 progress、human priority、status request、单次 handoff 和重复 handoff 的 v32 数据升级后均得到唯一且正确绑定的 owner。

本地只编辑和验证代码，不修改生产 SQLite、不部署、不重启线上服务。
