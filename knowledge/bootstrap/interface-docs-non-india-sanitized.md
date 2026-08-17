---
title: 非印度商户接口文档脱敏快照
scope: non_india
applicable_regions: 巴基斯坦,巴西,泰国,越南,印尼,菲律宾
source_kind: showdoc_visible_pages
source_label: PNM
captured_at: 2026-08-09T00:00:00+08:00
security: sanitized
code_verification: required_per_platform_branch
---

# 使用规则

- 本快照适用于巴基斯坦、巴西、泰国、越南、印尼和菲律宾，覆盖原文 10 个页面：接入说明、代收创建/回调/查询、代付创建/回调/查询、余额、银行编码和交易类型查询。
- 只保存接口路径、字段、类型、状态和业务规则；不保存文档网址、服务地址、回调地址、商户资料、账号、签名或密钥示例。
- 回答前必须拉取问题群映射的当前 Git 分支，用代码复核字段、必填、状态和地区校验；冲突时按当前代码解释并记录冲突。
- 交易类型和银行编码首先从本地 MagicBook 脱敏快照取值，再用当前分支代码确认；禁止把一个地区的编码套给另一个地区。
- AI 只解释接口，不调用创建订单或其他会改变业务状态的接口。

# 签名与接入约定

- 默认请求方式为 `POST`，内容类型为 `application/json`。
- 非空业务参数按字段名 ASCII 升序排列，以 `key=value` 形式使用 `&` 拼接；结尾不保留 `&`，随后直接追加商户 MD5Key，计算 MD5 并转成大写。
- `sign` 不参与自身签名；回调只对 `data` 内非空字段验签。
- MD5Key、签名原串和签名结果均属于敏感信息，禁止在群回复、日志、知识和导出中展示原值。

# 非印度代收创建订单

- 路径：`/api/xd/collectionOrder`
- 请求：`POST application/json`

## 请求字段

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `merchantOrderNo` | 是 | String | 商户订单号，需唯一 |
| `merchantNo` | 是 | String | 商户号，原值敏感 |
| `orderAmount` | 是 | BigDecimal/String | 订单金额 |
| `notifyUrl` | 是 | String | 商户回调地址，原值敏感 |
| `phone` | 是 | String | 直连联系电话，原值敏感，地区格式按代码确认 |
| `transactionType` | 是 | String | 地区交易类型，按 MagicBook 和当前代码取值 |
| `bankCode` | 是 | String | 地区银行编码或文档兼容值，按当前地区确认 |
| `payCardNo` | 是 | String | 付款账号，原值敏感 |
| `payName` | 是 | String | 付款人姓名，原值敏感 |
| `isCashier` | 是 | Boolean | 巴基斯坦可区分收银台/直连，其他地区文档要求 `false` |
| `sign` | 是 | String | 请求签名，原值敏感 |

## 地区规则

- 泰国：实名与非实名商户的 `bankCode` 传值不同，必须结合商户配置和当前代码确认。
- 巴西：必须使用系统银行编码，不能把兼容值当成真实银行编码。
- 巴基斯坦：`isCashier=true` 表示收银台，`false` 表示直连；其他地区文档要求 `false`。
- 其他地区：`transactionType` 与 `bankCode` 组合以本地 MagicBook 快照和当前代码共同确认。

## 响应字段

- 顶层：`success`、`message`、`code`、`result`、`timestamp`。
- 结果：`result.codeUrl`、`result.qrCode`、`result.orderNo`、`result.merchantNo`。
- 返回的实际地址、二维码和商户资料不得原样回复。

# 非印度代收回调

- 平台以 `POST application/json` 通知商户配置的回调地址。
- 订单成功时回调；成功但实际金额变化时也会回调。
- `orderState=0`：成功且金额未变化；`orderState=8`：成功但金额变化。
- `orderState=8` 时使用 `realPrice` 表示实际支付金额，签名也包含 `realPrice`。
- 回调字段：`code`、`msg`、`data.amount`、`data.refNo`、`data.orderNo`、`data.upi`、`data.merchNo`、`data.merchOrderNo`、`data.orderState`、`data.realPrice`、`data.sign`。
- 商户必须返回字符串 `success`，否则平台可能继续重试。

# 非印度代收查询

- 路径：`/api/xd/queryDsOrder`
- 请求字段：`orderNo`、`merchNo`、`sign`，文档均标为必填。
- 响应字段：`code`、`message`、`result.amount`、`result.realPrice`、`result.refNo`、`result.orderNo`、`result.merchNo`、`result.sign`、`result.msg`、`result.orderState`。
- 状态：`0` 成功、`1` 失败、`2` 初始化、`3` 冲正、`8` 成功但金额变化。
- 常见错误：商户不存在、验签失败、系统错误。

# 非印度代付创建订单

- 路径：`/api/xd/paymentOrder`
- 请求：`POST application/json`

## 请求字段

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `merchantOrderNo` | 是 | String | 商户订单号，需唯一 |
| `merchantNo` | 是 | String | 商户号，原值敏感 |
| `orderAmount` | 是 | String | 订单金额 |
| `bankAccount` | 是 | String | 银行账号或电子钱包账号，原值敏感 |
| `bankCode` | 是 | String | 当前地区银行编码或兼容值 |
| `payeeName` | 是 | String | 收款人姓名，原值敏感 |
| `phone` | 是 | String | 联系电话，原值敏感 |
| `email` | 是 | String | 联系邮箱，原值敏感 |
| `notifyUrl` | 是 | String | 回调地址，原值敏感 |
| `transactionType` | 是 | String | 当前地区交易类型 |
| `sign` | 是 | String | 请求签名，原值敏感 |

## 地区规则

- 印尼：银行卡出款使用银行编码；电子钱包等非银行卡方式的兼容值按当前代码确认。
- 巴基斯坦：兼容银行编码必须结合商户当前可用通道确认。
- 巴西：交易类型不能使用通用兼容值，必须选择当前可用的巴西交易类型。
- 其他地区：银行卡和电子钱包的交易类型/银行编码组合以本地 MagicBook 快照和当前代码共同确认。

## 响应与超时

- 响应字段：`success`、`message`、`code`、`result.orderNo`、`result.orderAmount`、`timestamp`。
- 只有下单接口返回明确失败 JSON 才能直接认定失败。
- `504`、超时、无响应或非明确失败 JSON 不能直接认定失败，也不能直接改派；先查询订单状态，仍无法确认时告警技术群。

# 非印度代付回调

- 成功和失败都会以 `POST application/json` 回调。
- 字段：`code`、`msg`、`data.amount`、`data.refNo`、`data.orderNo`、`data.merchNo`、`data.merchOrderNo`、`data.sign`、`data.orderState`、`data.msg`。
- 状态：字符串 `0` 成功、`1` 失败、`2` 处理中、`3` 冲正。
- 商户必须返回字符串 `success`，否则平台可能继续重试。

# 非印度代付查询

- 路径：`/api/xd/queryDfOrder`
- 请求字段：`orderNo`、`merchNo`、`sign`，文档均标为必填。
- 响应字段：`code`、`message`、`result.amount`、`result.refNo`、`result.orderNo`、`result.merchNo`、`result.sign`、`result.msg`、`result.orderState`。
- 状态：`0` 成功、`1` 失败、`2` 处理中、`3` 冲正。
- 原文的 `refNo` 描述存在异常标点，回答时必须看当前响应 DTO，不能照抄异常字段名。

# 非印度商户余额查询

- 路径：`/api/xd/balanceQuery`
- 请求字段：`merchNo`、`sign`，文档均标为必填。
- 响应字段：`code`、`message`、`result`。
- 商户号、签名和余额实际值不得原样出现在群回复中。

# 非印度查询支持银行编码

- 路径：`/api/xd/queryBankCode`
- 功能：按商户号和业务类型查询当前可用通道支持的银行编码。
- 请求字段：`merchNo`、`type`、`sign`。
- `type`：原文支持 `DS`、`DF`、`DFC`，实际范围按当前代码确认。
- 签名业务字段为 `merchNo`、`type`，不包含 `sign`。
- 成功结果项：`bankCode`、`bankDesc`。
- 常见错误：商户号缺失、业务类型缺失或不支持、签名缺失、验签失败、商户不存在。
- 返回值只能用于当前商户、当前业务和当前地区，不能缓存后跨地区复用。

# 非印度查询支持交易类型

- 路径：`/api/xd/queryTransactionType`
- 功能：按商户号和业务类型查询当前可用通道支持的交易类型。
- 请求字段：`merchNo`、`type`、`sign`。
- `type`：原文要求 `DS` 或 `DF`；若业务概念为 `DFC`，原文要求按 `DF` 传入，仍需当前代码确认。
- 成功结果项：`code`、`desc`。
- 常见错误：商户号缺失、业务类型缺失或不支持、签名缺失、验签失败、商户不存在。
- 查询结果只适用于当前商户和地区，不能返回印度或其他地区枚举。

# 回复定位规则

- 单个明显参数错误时回复原消息，并只引用字段名或安全片段。
- 多个错误集中在连续 JSON/表格片段时，引用该连续片段后一次说明。
- 错误分散、重点过多或无法安全定位时，回复整条原消息并汇总。
- `merchantNo`、`bankAccount`、`payCardNo`、`phone`、`email`、`notifyUrl`、`upi`、`utr`、`sign` 和任何密钥禁止原样引用。
