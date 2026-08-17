---
title: 印度商户接口文档脱敏快照
scope: india
applicable_regions: 印度
source_kind: showdoc_visible_pages
source_label: 通道对接文档
captured_at: 2026-08-09T00:00:00+08:00
security: sanitized
code_verification: required_per_platform_branch
---

# 使用规则

- 本快照只适用于印度服务，覆盖原文 11 个页面：接入说明、代收创建/回调/查询、代付创建/回调/查询、UTR 查询/补单、余额查询和 UPI 查询。
- 只保存接口路径、字段、类型、状态和业务规则，不保存文档网址、服务地址、回调地址、商户资料、账号、UPI、UTR、签名或密钥示例。
- 回答前必须拉取问题群映射的当前 Git 分支，用代码复核字段、必填和校验逻辑；文档与代码冲突时按代码解释并记录冲突。
- 印度接口不使用非印度地区的 `transactionType` 和 `bankCode` 字段或枚举；印度银行路由信息按当前印度分支 DTO 和校验字段确认。
- AI 只解释接口，绝不调用创建订单、UTR 补单等写接口。

# 签名与接入约定

- 默认请求方式为 `POST`，内容类型为 `application/json`。
- 非空业务参数按字段名 ASCII 升序排列，以 `key=value` 形式使用 `&` 拼接；结尾不保留 `&`，随后直接追加商户 MD5Key，计算 MD5 并转成大写。
- `sign` 不参与自身签名；回调只对 `data` 内非空字段验签。
- MD5Key、签名原串和签名结果均属于敏感信息，禁止在群回复、日志、知识和导出中展示原值。

# 印度代收创建订单

- 路径：`/api/xd/collectionOrder`
- 请求：`POST application/json`

## 请求字段

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `merchantOrderNo` | 是 | String | 商户订单号，需唯一 |
| `merchantNo` | 是 | String | 商户号，原值敏感 |
| `orderAmount` | 是 | BigDecimal/String | 订单金额 |
| `notifyUrl` | 是 | String | 商户回调地址，原值敏感 |
| `phone` | 是 | String | 联系电话，原值敏感，格式按当前代码确认 |
| `payCardNo` | 代码确认 | String | 付款账号，原值敏感 |
| `payName` | 代码确认 | String | 付款人姓名，原值敏感 |
| `isCashier` | 代码确认 | Boolean | 印度不使用巴基斯坦收银台语义 |
| `sign` | 是 | String | 请求签名，原值敏感 |

## 响应字段

- 顶层：`success`、`message`、`code`、`result`、`timestamp`。
- 结果：`result.codeUrl`、`result.qrCode`、`result.orderNo`、`result.merchantNo`。
- `codeUrl`、`qrCode` 等实际值可能包含受限地址或收款信息，回复时只解释字段含义。

# 印度代收回调

- 平台以 `POST application/json` 通知商户配置的回调地址。
- 订单成功时回调；成功但实际金额变化时也会回调。
- `orderState=0`：成功且金额未变化；`orderState=8`：成功但金额变化。
- `orderState=8` 时使用 `realPrice` 表示实际支付金额，签名也包含 `realPrice`。
- 回调字段：`code`、`msg`、`data.amount`、`data.refNo`、`data.orderNo`、`data.upi`、`data.merchNo`、`data.merchOrderNo`、`data.orderState`、`data.realPrice`、`data.sign`。
- 商户必须返回字符串 `success`，否则平台可能继续重试。

# 印度代收查询

- 路径：`/api/xd/queryDsOrder`
- 请求字段：`orderNo`、`merchNo`、`sign`，文档均标为必填。
- 响应字段：`code`、`message`、`result.amount`、`result.realPrice`、`result.refNo`、`result.orderNo`、`result.merchNo`、`result.sign`、`result.msg`、`result.orderState`。
- 状态：`0` 成功、`1` 失败、`2` 初始化、`3` 冲正、`8` 成功但金额变化。
- 常见错误：商户不存在、验签失败、系统错误。

# 印度代付创建订单

- 路径：`/api/xd/paymentOrder`
- 请求：`POST application/json`

## 请求字段

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `merchantOrderNo` | 是 | String | 商户订单号，需唯一 |
| `merchantNo` | 是 | String | 商户号，原值敏感 |
| `orderAmount` | 是 | String | 订单金额 |
| `bankAccount` | 是 | String | 银行账号或 UPI，原值敏感 |
| `payeeName` | 是 | String | 收款人姓名，原值敏感 |
| `phone` | 是 | String | 联系电话，原值敏感 |
| `email` | 是 | String | 联系邮箱，原值敏感 |
| `notifyUrl` | 是 | String | 回调地址，原值敏感 |
| `sign` | 是 | String | 请求签名，原值敏感 |

## 响应与超时

- 响应字段：`success`、`message`、`code`、`result.orderNo`、`result.orderAmount`、`timestamp`。
- 只有下单接口返回明确失败 JSON 才能直接认定失败。
- `504`、超时、无响应或非明确失败 JSON 不能直接认定失败，也不能直接改派；先查询订单状态，仍无法确认时告警技术群。

# 印度代付回调

- 成功和失败都会以 `POST application/json` 回调。
- 字段：`code`、`msg`、`data.amount`、`data.refNo`、`data.orderNo`、`data.merchNo`、`data.merchOrderNo`、`data.sign`、`data.orderState`、`data.msg`。
- 状态：字符串 `0` 成功、`1` 失败、`2` 处理中、`3` 冲正。
- 商户必须返回字符串 `success`，否则平台可能继续重试。

# 印度代付查询

- 路径：`/api/xd/queryDfOrder`
- 请求字段：`orderNo`、`merchNo`、`sign`，文档均标为必填。
- 响应字段：`code`、`message`、`result.amount`、`result.refNo`、`result.orderNo`、`result.merchNo`、`result.sign`、`result.msg`、`result.orderState`。
- 状态：`0` 成功、`1` 失败、`2` 处理中、`3` 冲正。
- 原文的 `refNo` 描述存在异常标点，回答时必须看当前响应 DTO，不能照抄异常字段名。

# 印度 UTR 查询

- 路径：`/api/xd/queryUtr`
- 功能：查询 UTR 是否存在以及是否已绑定订单。
- 请求字段：`merchNo`、`utr`、`sign`，均为必填；原值按敏感信息处理。
- 响应字段：`code`、`message`、`result.utr`、`result.utrAmount`、`result.bind`、`result.bindOrderNo`。
- `bind`：`0` 不存在、`1` 已收到且已认领、`2` 已收到但未认领。
- 原文对成功码存在 `0` 与 `200` 两种说明，回答前必须按当前代码确认。

# 印度 UTR 补单

- 路径：`/api/xd/bindUtr`
- 功能：提交 UTR 并尝试绑定代收订单，属于会改变订单状态的写操作。
- 请求字段：`merchNo`、`orderNo`、`utr`、`timestamp`、`sign`。
- 响应字段：`success`、`message`、`code`、`result`、`timestamp`。
- AI 客服只能解释字段和排查参数，绝不调用本接口；实际补单交给有权限的人工流程。

# 印度商户余额查询

- 路径：`/api/xd/balanceQuery`
- 请求字段：`merchNo`、`sign`，文档均标为必填。
- 响应字段：`code`、`message`、`result`。
- 商户号、签名和余额实际值不得原样出现在群回复中。

# 印度 UPI 查询

- 路径：`/api/xd/queryUpi`
- 功能：查询指定 UPI 是否属于平台管理的收款账号。
- 请求字段：`merchNo`、`upi`、`sign`，均为必填；原值按敏感信息处理。
- 响应字段：`code`、`message`。
- 原文语义：`200` 表示属于平台，`500` 表示不属于；回答前仍需按当前代码确认。

# 回复定位规则

- 单个明显参数错误时回复原消息，并只引用字段名或安全片段。
- 多个错误集中在连续 JSON/表格片段时，引用该连续片段后一次说明。
- 错误分散、重点过多或无法安全定位时，回复整条原消息并汇总。
- `merchantNo`、`bankAccount`、`payCardNo`、`phone`、`email`、`notifyUrl`、`upi`、`utr`、`sign` 和任何密钥禁止原样引用。
