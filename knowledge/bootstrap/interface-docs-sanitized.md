---
title: 商户接口文档脱敏快照
source_kind: showdoc_visible_pages
captured_at: 2026-08-09T00:00:00+08:00
source_labels:
  - 通道对接文档
  - PNM
security: sanitized
code_verification: required_per_platform_branch
---

# 使用规则

- 本文件只保存接口路径、字段名、类型、业务规则和错误语义，不保存文档网址、服务地址、回调地址、商户号、账号、手机号、邮箱、UPI、UTR、签名或 MD5Key 示例原值。
- 回答前必须先同步问题群对应 Git 分支，用当前代码确认接口是否存在、字段是否必填和实际校验逻辑。
- 文档与代码冲突时，当前代码用于解释实际行为，文档差异进入知识冲突记录。
- 印度没有 MagicBook 地区交易类型和地区银行编码字典；印度分支仍可能要求 `bankCode`/IFSC 字段，不能混为一件事。
- 本系统只解释接口，不调用会创建订单、补单或改变业务状态的接口。

# 通用约定

- 默认请求方式：`POST`。
- 默认内容类型：`application/json`。
- 所有商户接口均需签名与验签。
- 签名规则：非空业务参数按字段名 ASCII 升序排列，使用 `key=value&key2=value2` 拼接，末尾不保留 `&`，直接追加商户 MD5Key，计算 MD5 后转大写。
- MD5Key、请求签名和签名原串都属于敏感信息，群回复不得展示原值。

# 代收下单

- 路径：`/api/xd/collectionOrder`
- 请求：`POST application/json`

## 请求字段

| 字段 | 必填 | 类型 | 文档说明 |
|---|---|---|---|
| `merchantOrderNo` | 是 | String | 商户订单号，需唯一 |
| `merchantNo` | 是 | String | 商户号；实际值敏感 |
| `orderAmount` | 是 | BigDecimal/String | 订单金额，支持小数 |
| `notifyUrl` | 是 | String | 商户回调地址；实际值敏感 |
| `phone` | 是 | String | 直连模式使用的联系电话；实际值敏感，地区格式需按代码确认 |
| `transactionType` | 是 | String | 地区交易类型；印度分支是否存在该字段必须看当前代码 |
| `bankCode` | 是 | String(32) | 地区银行编码或兼容值；印度可能是 IFSC 自由输入 |
| `payCardNo` | 是 | String(32) | 付款账号；实际值敏感 |
| `payName` | 是 | String(32) | 付款人姓名；实际值敏感 |
| `isCashier` | 是 | Boolean | 巴基斯坦可区分收银台/直连，其他地区文档要求 `false` |
| `sign` | 是 | String | 请求签名；实际值敏感 |

## 地区规则

- 泰国：文档区分实名与非实名商户的 `bankCode` 传值，必须结合商户配置和当前代码确认。
- 巴西：文档要求使用系统银行编码，不允许把兼容值当银行编码；必须结合当前代码确认。
- 其他非印度地区：文档存在 `transactionType` 与 `bankCode` 联动规则，实际组合以 MagicBook 当前参数和当前代码为准。
- 巴基斯坦：`isCashier=true` 表示收银台，`false` 表示直连；其他地区文档要求 `false`。

## 响应字段

`success`、`message`、`code`、`result`、`result.codeUrl`、`result.qrCode`、`result.orderNo`、`result.merchantNo`、`timestamp`。

# 代收回调

- 通知：`POST application/json`，回调地址由商户侧配置。
- 触发：订单成功；成功但实际金额变化时也会通知。
- 状态：`orderState=0` 表示成功且金额未变化；`orderState=8` 表示成功但金额变化。
- 金额变化：`orderState=8` 时使用 `realPrice` 表示实际支付金额，签名也包含 `realPrice`。
- 验签：只对 `data` 中非空字段签名。
- 商户响应：必须返回字符串 `success`，否则平台可能重试。

## 回调字段

`code`、`msg`、`data.amount`、`data.refNo`、`data.orderNo`、`data.upi`、`data.merchNo`、`data.merchOrderNo`、`data.orderState`、`data.realPrice`、`data.sign`。

# 代收查询

- 路径：`/api/xd/queryDsOrder`
- 请求字段：`orderNo`、`merchNo`、`sign`，文档均标为必填。
- 响应字段：`code`、`message`、`result.amount`、`result.realPrice`、`result.refNo`、`result.orderNo`、`result.merchNo`、`result.sign`、`result.msg`、`result.orderState`。
- 状态：`0` 成功、`1` 失败、`2` 初始化、`3` 冲正、`8` 成功但金额变化。
- 常见错误：商户不存在、验签失败、系统错误。

# 代付下单

- 路径：`/api/xd/paymentOrder`
- 请求：`POST application/json`

## 请求字段

| 字段 | 必填 | 类型 | 文档说明 |
|---|---|---|---|
| `merchantOrderNo` | 是 | String | 商户订单号 |
| `merchantNo` | 是 | String | 商户号；实际值敏感 |
| `orderAmount` | 是 | String | 订单金额 |
| `bankAccount` | 是 | String | 银行账号或 UPI；实际值敏感 |
| `bankCode` | 是 | String | 银行编码；印度分支可能使用 IFSC |
| `payeeName` | 是 | String | 收款人姓名；实际值敏感 |
| `phone` | 是 | String | 联系电话；实际值敏感 |
| `email` | 是 | String | 联系邮箱；实际值敏感 |
| `notifyUrl` | 是 | String | 回调地址；实际值敏感 |
| `transactionType` | 是 | String | 地区交易类型；印度分支是否存在必须看当前代码 |
| `sign` | 是 | String | 请求签名；实际值敏感 |

## 地区规则

- 印尼：银行卡出款使用银行编码；非银行卡方式的兼容值以当前代码为准。
- 巴基斯坦：文档给出兼容银行编码规则，必须以当前代码和商户可用通道为准。
- 巴西：交易类型不能使用通用兼容值，必须从当前可用交易类型中选择。
- 其他非印度地区：银行卡出款和电子钱包的交易类型、银行编码组合以 MagicBook 和代码共同确认。

## 响应和超时

- 响应字段：`success`、`message`、`code`、`result.orderNo`、`result.orderAmount`、`timestamp`。
- 只有下单接口明确返回失败 JSON 才能直接认定失败。
- `504`、超时、无响应或非明确失败 JSON 不能直接认定失败，也不能直接改派；应先查询订单状态，仍无法确认时告警技术部并由人工处理。

# 代付回调

- 通知：`POST application/json`。
- 成功和失败都会回调。
- 验签：只对 `data` 中非空字段签名。
- 商户响应：必须返回字符串 `success`，否则平台可能重试。
- 回调字段：`code`、`msg`、`data.amount`、`data.refNo`、`data.orderNo`、`data.merchNo`、`data.merchOrderNo`、`data.sign`、`data.orderState`、`data.msg`。
- 状态：字符串 `0` 成功、`1` 失败、`2` 处理中、`3` 冲正。

# 代付查询

- 路径：`/api/xd/queryDfOrder`
- 请求字段：`orderNo`、`merchNo`、`sign`，文档均标为必填。
- 响应字段：`code`、`message`、`result.amount`、`result.refNo`、`result.orderNo`、`result.merchNo`、`result.sign`、`result.msg`、`result.orderState`。
- 状态：`0` 成功、`1` 失败、`2` 处理中、`3` 冲正。
- 文档中的 `refNo` 展示存在异常标点/空格描述，不能照抄字段名，必须查看当前分支响应 DTO 和序列化代码。

# 商户余额查询

- 路径：`/api/xd/balanceQuery`
- 请求字段：`merchNo`、`sign`，文档均标为必填。
- 响应字段：`code`、`message`、`result`。

# 查询支持银行编码

- 路径：`/api/xd/queryBankCode`
- 功能：按商户号和业务类型查询当前可用通道支持的银行编码。
- 请求字段：`merchNo`、`type`、`sign`。
- `type`：文档支持 `DS`、`DF`、`DFC`，实际支持范围必须以当前代码为准。
- 签名字段：`merchNo`、`type`，不包含 `sign`。
- 成功结果项：`bankCode`、`bankDesc`。
- 常见错误：商户号缺失、业务类型缺失或不支持、签名缺失、验签失败、商户不存在。
- 印度没有 MagicBook 地区银行编码字典；印度的 IFSC 输入不能用本接口的地区枚举语义代替。

# 查询支持交易类型

- 路径：`/api/xd/queryTransactionType`
- 功能：按商户号和业务类型查询当前可用通道支持的交易类型。
- 请求字段：`merchNo`、`type`、`sign`。
- `type`：当前文档要求 `DS` 或 `DF`；若业务概念为 `DFC`，文档要求按 `DF` 传入，仍需代码确认。
- 成功结果项：`code`、`desc`。
- 常见错误：商户号缺失、业务类型缺失或不支持、签名缺失、验签失败、商户不存在。
- 印度没有 MagicBook 地区交易类型选项，不允许返回其他地区枚举。

# UTR 查询

- 路径：`/api/xd/queryUtr`
- 功能：按 UTR 查询是否存在以及是否绑定订单。
- 请求字段：`merchNo`、`utr`、`sign`，文档均标为必填；实际值均按敏感信息处理。
- 响应字段：`code`、`message`、`result.utr`、`result.utrAmount`、`result.bind`、`result.bindOrderNo`。
- `bind` 文档语义：`0` 不存在、`1` 已收到且已认领、`2` 已收到但未认领。
- 文档对成功码存在 `0` 与 `200` 两种描述，回答前必须查看当前代码，不能直接引用其中一个。

# UTR 补单

- 路径：`/api/xd/bindUtr`
- 功能：提交 UTR 并尝试绑定代收订单，属于会改变订单状态的写操作。
- 请求字段：`merchNo`、`orderNo`、`utr`、`timestamp`、`sign`。
- 响应字段：`success`、`message`、`code`、`result`、`timestamp`。
- AI 客服只能解释字段和排查参数，绝不调用该接口；需要实际补单时交给有权限的人工流程。

# UPI 查询

- 路径：`/api/xd/queryUpi`
- 功能：查询指定 UPI 是否属于平台管理的收款账号。
- 请求字段：`merchNo`、`upi`、`sign`，文档均标为必填；实际值均按敏感信息处理。
- 响应字段：`code`、`message`。
- 文档语义：`200` 表示属于平台，`500` 表示不属于；回答前仍需查看当前代码。

# 回复定位规则

- 参数只有一个明显错误时，回复原消息并局部引用该字段或原值片段。
- 多个错误集中在一个连续 JSON/表格片段时，局部引用整个连续片段后一次说明。
- 错误分散、重点过多或无法安全定位时，回复整条原消息并汇总，不连续刷屏。
- `merchantNo`、`bankAccount`、`payCardNo`、`phone`、`email`、`notifyUrl`、`upi`、`utr`、`sign` 和任何密钥值禁止原样局部引用，只能使用字段名或脱敏片段。
