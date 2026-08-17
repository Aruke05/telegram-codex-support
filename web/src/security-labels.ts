import type { SensitiveCategory } from "./types.js"

const labels: Record<SensitiveCategory, string> = {
  "private-key": "私钥",
  "connection-string": "连接串",
  "absolute-url": "受限网址",
  credential: "账号凭据",
  "business-identifier": "业务敏感字段",
  email: "邮箱",
  "ip-address": "IP 地址",
  "bank-card": "银行卡号",
}

export function sensitiveCategoryLabel(category: SensitiveCategory): string {
  return labels[category]
}
