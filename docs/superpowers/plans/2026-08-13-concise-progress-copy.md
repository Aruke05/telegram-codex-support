# 简短进度提示文案实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将回答生成超过三分钟时的进度通知正文固定为两个字 `稍等`。

**Architecture:** 保留现有进度通知调度、状态校验、人类口吻格式化、Telegram 发送和持久化归属链路，只收紧客服文案常量。现有发送链路集成测试改为断言精确正文，防止以后重新扩写。

**Tech Stack:** TypeScript 5.9、Vitest 3、Node.js 22、SQLite

## Global Constraints

- 三分钟进度提示正文严格等于 `稍等`。
- 不随机选择文案，不模拟打字错误，不发送单独表情，也不给原消息添加表情回应。
- 真正达到回答运行上限或一小时硬截止时继续使用现有诚实超时兜底。
- 不新增配置、接口、数据库结构或依赖。
- 只提交本功能文件，不纳入工作区已有删除和未跟踪内容。

---

### Task 1: 收紧三分钟进度提示正文

**Files:**
- Modify: `tests/support/human-takeover.test.ts:776`
- Modify: `src/support/operator-copy.ts:2`

**Interfaces:**
- Consumes: `SupportDeadlineService.runOnce(now?: Date): Promise<void>` 现有进度通知发送行为。
- Produces: `operatorCopy.progress` 固定值 `"稍等"`；其他客服文案和发送接口不变。

- [ ] **Step 1: 写入失败的集成测试断言**

把 `progress 实际发送携带统一 thread ownership，发送中接管不伪称 cancelled` 测试中的正文断言从任意字符串改为精确值：

```ts
expect(sendMessage).toHaveBeenCalledWith(
  harness.group.accountId,
  harness.group.telegramChatId,
  "稍等",
  thread.anchorMessageId,
  undefined,
  {
    groupId: harness.group.id,
    threadId: thread.id,
    serviceId: thread.serviceId,
    notificationId: notification.id,
    kind: "progress",
  },
)
```

- [ ] **Step 2: 运行目标测试并确认因旧文案失败**

Run:

```bash
pnpm test tests/support/human-takeover.test.ts -t "progress 实际发送携带统一 thread ownership"
```

Expected: FAIL，实际收到的第三个参数是 `正在排查 请稍等`，而不是 `稍等`。

- [ ] **Step 3: 写入最小实现**

在 `src/support/operator-copy.ts` 只修改进度文案：

```ts
export const operatorCopy = {
  progress: "稍等",
  hourTimeout: "时间有点久 具体异常和订单号请提供 我再看",
  implicitHelp: "哪个上游 订单号和大概时间请提供",
  codeUnavailable: "当前代码没同步下来 这条暂时没法准确确认 我再跟进",
  technicalNotified: "我已经通知技术同事处理了",
} as const
```

- [ ] **Step 4: 运行目标测试并确认通过**

Run:

```bash
pnpm test tests/support/human-takeover.test.ts -t "progress 实际发送携带统一 thread ownership"
```

Expected: PASS，1 个目标测试通过。

- [ ] **Step 5: 运行完整验证**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: 所有命令退出码为 0，无测试失败、类型错误、构建错误或空白错误。

- [ ] **Step 6: 提交实现**

```bash
git add tests/support/human-takeover.test.ts src/support/operator-copy.ts
git commit -m "客服：稍等提示精简为两个字"
```
