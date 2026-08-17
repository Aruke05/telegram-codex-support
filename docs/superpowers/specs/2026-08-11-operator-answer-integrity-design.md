# 客服回复内容完整性设计

## 目标

客服回复保持简短自然和少标点风格时 不得改变业务事实中的结构化值

必须完整保留 URL 接口路径 IPv4 IPv6 域名与端口 金额与千分位 时间 日期 版本号 文件名 类名 JSON 和代码片段

## 调研结论

- OpenAI Agents SDK 把最终回复约束放在 output guardrail 中 校验失败时阻断或重试 而不是对未知内容做不可逆的全局替换
- Intercom Fin 用 Guidance 控制语气和长度 并通过 Preview 与 Batch test 验证真实回答 将风格控制和内容正确性评估分开
- Microsoft Presidio 对敏感实体使用带起止位置的 recognizer span 再对命中区间执行替换 避免全局正则误伤其他文本
- Node.js 提供 WHATWG URL 和 `net.isIP` 等稳定解析能力 结构化值应优先使用解析器验证

参考：

- https://openai.github.io/openai-agents-js/guides/guardrails/
- https://www.intercom.com/help/en/articles/10210126-provide-fin-ai-agent-with-specific-guidance
- https://www.intercom.com/help/en/articles/10521711-batch-test-fin-ai-agent
- https://data-privacy-stack.github.io/presidio/anonymizer/
- https://nodejs.org/api/url.html
- https://nodejs.org/api/net.html#netisipinput

## 现状问题

当前 `humanizeOperatorAnswer` 先用一个正则把少量结构化内容替换为占位符 然后全局删除标点

这种方式已确认会破坏：

- `gateway.vpay.top` 变成 `gateway vpay top`
- `gateway.vpay.top:443` 变成 `gateway vpay top 443`
- `2001:db8::1` 变成 `2001 db8 1`
- `1,234.56` 变成 `1 234.56`
- JSON 的冒号和逗号被删除
- `java.lang.NullPointerException` 变成空格分隔文本

继续向单个大正则追加例外会不断出现新的重叠和边界错误

## 方案比较

### 方案一 继续扩展单个正则

改动最小 但不同类型会互相重叠 IPv4 被拆成两个小数就是典型问题 不采用

### 方案二 完全取消发送前口语化

内容最安全 但会失去用户已经确认的少标点 群聊口语和两行限制 不采用

### 方案三 Guidance 加区间保护加完整性校验

采用此方案

模型提示词负责自然语气 确定性代码只做有限的报告腔替换和空白整理 标点处理只作用于普通语言区间

## 处理流程

1. 接收模型原始 `answer`
2. 识别结构化区间
   - fenced code 与 inline code
   - 可解析 JSON 对象或数组
   - HTTP URL
   - POSIX 接口路径
   - IPv4 IPv6 可选端口与 CIDR
   - 域名 主机名 文件名 类名与可选端口
   - 金额 千分位 小数 百分比
   - 时间 日期 版本号
3. 合并重叠区间并替换成不可与业务内容冲突的占位符
4. 只对剩余自然语言执行正式措辞替换 标点转空格 空白合并和两行限制
5. 按原始区间恢复结构化内容
6. 从格式化前后再次提取结构化值并比较
7. 如果任何值丢失 改写或顺序变化 放弃破坏性标点处理 只执行不改变业务值的措辞和空白整理
8. 继续执行现有 business-outbound 敏感信息检查

## 技术细节回答

运营明确询问 URL IP 参数 响应 JSON 或错误细节时 内容完整性优先级高于少标点风格

此类回答仍做报告腔替换 空白整理和两行限制 但不删除结构化区间内的任何字符

## 安全边界

- 不放宽 Token 密钥 密码 Session 私钥 商户密钥和连接凭据阻断
- 业务 URL 与业务 IP 继续按现有 outbound 策略允许
- 不把输入内容直接当成可执行代码
- JSON 只做解析识别 不执行
- 不新增外部依赖

## 验证矩阵

服务器一次性断言至少覆盖：

- IPv4 及 IPv4 端口
- IPv6 及方括号端口
- 域名及域名端口
- URL 查询参数
- 接口路径
- 普通小数 负数 百分比 千分位金额
- 时间 日期 版本号
- JSON 与 inline code
- Java 类名或文件名
- 普通中文回复的去标点和两行限制
- 正式措辞替换

不提交测试文件 按项目约束使用服务器一次性回归脚本并执行现有完整测试套件
