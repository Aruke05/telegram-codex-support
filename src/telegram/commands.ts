export const chineseBotCommands = [
  { command: "start", description: "查看当前群 ID 和自己的用户 ID" },
  { command: "info", description: "查看自己或指定用户的 Telegram ID" },
  { command: "ai", description: "客服群：/ai 问题；技术群：/ai 服务 问题" },
  { command: "help", description: "查看 AI 客服使用说明" },
  { command: "correct", description: "回复错误答案后输入 /correct 正确内容" },
] as const
