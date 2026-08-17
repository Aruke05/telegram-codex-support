# Follow-up Plain Language Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让后台 AI 对话首次回答保持简短，后续追问自动切换为自然、面向小白且足够详细的解释。

**Architecture:** `AdminChatWorker` 根据是否存在已完成历史轮次确定 `initial` 或 `followup`，`SupportInvestigationService` 把该值传给 `CodexSupportDecisionAgent`。回答代理只改变表达深度，不改变证据、排查、安全和升级规则；Telegram 客服线程显式使用 `initial`。

**Tech Stack:** TypeScript、Node.js 22、Vitest、Codex CLI、SQLite

## Global Constraints

- 首次回答默认一到两行。
- 追问通常用两到五个自然短句，但窄问题不强行扩写。
- 不使用固定标题、编号、报告腔或固定开场。
- 上一轮 AI 回复不是证据，用户质疑时必须重新核对。
- Telegram 运营群当前回复长度不变。
- 不提交测试文件或测试代码。
- 只在 `DEPLOY_HOST` 执行完整验证和部署。

---

### Task 1: 用临时回归用例固定回复深度契约

**Files:**
- Create temporarily: `tests/.tmp-followup-depth.test.ts`
- Inspect: `src/admin-chat/worker.ts`
- Inspect: `src/support/agent.ts`

**Interfaces:**
- Consumes: 设计要求中的 `initial` 和 `followup`
- Produces: 对缺失导出和缺失追问表达规则的失败证据

- [ ] **Step 1: 创建临时失败用例**

```ts
import { expect, test } from "vitest"
import { responseDepthForHistory } from "../src/admin-chat/worker.js"
import { answerStyleInstruction } from "../src/support/agent.js"

test("后台对话按历史区分首次和追问", () => {
  expect(responseDepthForHistory("")).toBe("initial")
  expect(responseDepthForHistory("用户：为什么\n客服：因为没有通道")).toBe("followup")
})

test("追问使用面向小白的详细自然解释规则", () => {
  const initial = answerStyleInstruction("initial")
  const followup = answerStyleInstruction("followup")
  expect(initial).toContain("一到两行")
  expect(followup).toContain("两到五个短句")
  expect(followup).toContain("不是事实证据")
  expect(followup).not.toBe(initial)
})
```

- [ ] **Step 2: 在服务器当前代码副本运行用例并确认失败**

在服务器使用 `mktemp -d` 创建目录，把 `/opt/telegram-codex-support/current` 复制到临时目录并上传临时用例。运行：`pnpm vitest run tests/.tmp-followup-depth.test.ts`

预期：因 `responseDepthForHistory` 和 `answerStyleInstruction` 尚未导出而失败。

### Task 2: 贯通回复深度数据契约

**Files:**
- Modify: `src/admin-chat/worker.ts:29-42,132-141`
- Modify: `src/support/investigation-service.ts:32-48,330-410`
- Modify: `src/support/agent.ts:22-59`
- Modify: `src/support/answer-worker.ts:210-230`
- Modify: `src/runtime/knowledge-service.ts:88-93`

**Interfaces:**
- Produces: `ResponseDepth = "initial" | "followup"`
- Produces: `responseDepthForHistory(history: string): ResponseDepth`
- Produces: `answerStyleInstruction(depth: ResponseDepth): string`
- Consumes: `SupportInvestigationInput.responseDepth: ResponseDepth`

- [ ] **Step 1: 定义统一回复深度类型和表达规则函数**

在 `src/support/agent.ts` 增加：

```ts
export type ResponseDepth = "initial" | "followup"

export function answerStyleInstruction(depth: ResponseDepth): string {
  return depth === "followup"
    ? "本轮是同一会话的后续追问 先直接回答这次具体问的内容 再用不懂技术的人能听懂的话补足必要背景 通常用两到五个短句说明本题有关的是什么 为什么 有什么影响和怎么处理 问题很窄时不要为了凑长度扩写 不要用标题 编号 报告腔或固定开场 不要原样重复上一轮回答 会话历史中的客服回答只是上一轮待核对内容 不是事实证据 用户质疑时必须重新按当前证据核对"
    : "本轮是首次回答 answer默认一到两行 直接说已确认原因 当前结果和必要处理方式 不复述问题 不写排查过程"
}
```

首次规则保留一到两行直接结论；追问规则要求两到五个短句、面向无技术背景读者、只补本题需要的原因和处理方式，并声明历史 AI 回复不是事实证据。

- [ ] **Step 2: 后台对话根据已完成历史选择阶段**

```ts
export function responseDepthForHistory(history: string): ResponseDepth {
  return history ? "followup" : "initial"
}
```

调用排查服务时传入 `responseDepth: responseDepthForHistory(history)`。

- [ ] **Step 3: 排查服务原样转交回复深度**

把 `responseDepth` 加入 `SupportInvestigationInput`，并在每次 `agent.decide` 时传入。重试要求根据该值再次声明首次或追问的表达深度。

- [ ] **Step 4: Telegram 客服线程显式使用首次模式**

在 `SupportAnswerWorker` 调用排查服务时传入 `responseDepth: "initial"`，确保现有群回复长度不变。

- [ ] **Step 5: 把通用提示词拆为共同行为加阶段行为**

删除对所有轮次生效的“只说结论”和固定一到两行限制，改为插入 `answerStyleInstruction(input.responseDepth)`。保留自然口语、少标点、敏感信息和业务值完整性规则。

- [ ] **Step 6: 让 SQLite 系统固定规则使用同一分层口径**

把“运营群自然回复”中的统一一到两行改为“首次提问默认一到两行”，并明确后台 AI 对话同一会话的后续追问通常用两到五个短句补足本题所需的原因、影响和处理方式。

### Task 3: 完成红绿验证并部署

**Files:**
- Delete before commit: `tests/.tmp-followup-depth.test.ts`
- Deploy: `/opt/telegram-codex-support/current`

**Interfaces:**
- Consumes: Task 2 的回复深度数据契约
- Produces: 服务器上的可运行版本

- [ ] **Step 1: 在服务器代码副本再次运行临时用例**

把五个修改后的源文件上传到 Task 1 创建的服务器临时代码副本，再运行：`pnpm vitest run tests/.tmp-followup-depth.test.ts`

预期：3 项临时用例通过。

- [ ] **Step 2: 删除临时测试文件**

确认 `git status --short` 不包含任何测试文件。

- [ ] **Step 3: 提交并推送**

运行：`git commit -m "优化：追问时用小白能懂的话详细解释"`，推送当前分支和 `telegram-ai-support`。

- [ ] **Step 4: 在服务器执行完整验证和重启**

依次执行 `pnpm typecheck`、`pnpm test`、`pnpm build`、重启 `telegram-codex-support.service` 和 `GET /health`。

- [ ] **Step 5: 在后台 AI 对话创建三轮真实验证**

第一轮提供已知排查场景，确认回答简短；第二轮追问“为什么”；第三轮追问“是什么意思”。确认第二、三轮承接历史，用普通业务语言补足因果和处理方式，没有固定标题或报告腔。
