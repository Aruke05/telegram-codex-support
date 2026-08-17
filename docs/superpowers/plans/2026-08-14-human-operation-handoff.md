# 专人操作客服承接与技术群真实转发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让创建账号、用户解冻等明确由专人执行的请求在信息齐全后生成自然客服确认回复，并通过现有持久升级链路真实转发完整原消息线程到技术群。

**Architecture:** 在结构化回答中增加独立的 `human_operation` 升级类型，回答模型负责结合完整线程判断信息是否齐全并生成现场客服文案，调查服务只验证 `[专人操作]` 标记和可信消息证据。回答工作者不新增专用发送分支，继续复用普通 `escalation` delivery、Telegram 原消息转发、ownership 去重和恢复逻辑。

**Tech Stack:** TypeScript 5.9、Zod 4、Vitest 3、Telegram Bot/Teleproto 现有转发接口、SQLite 持久 delivery 与 output ownership。

## Global Constraints

- 所有明确由专人执行的操作统一处理，不只覆盖创建运营账号。
- 信息不足时只追问当前最少需要的一项，不转发技术群。
- 信息齐全时先发起真实技术群转发，再发送模型现场生成的运营回复。
- 运营回复必须确认收到并安抚，不得声称账号已创建、用户已解冻或承诺完成时间。
- 技术群只接收完整 Telegram 原消息转发，不新增拼装告警文本。
- 技术群投递状态必须忠于 `sent`、`not_configured`、`failed` 或 `uncertain`，不得从客服文案推断。
- `uncertain` ownership 不得盲目重发；继续复用现有持久恢复边界。
- 不执行生产写操作，不部署、不启动或重启本机及生产客服服务。
- 临时回归测试必须先失败再通过，并在提交前删除；不得提交测试文件或测试代码。

---

## File Structure

- Modify: `src/codex/schemas.ts` — 声明 `human_operation` 的 Zod 与 JSON Schema 枚举。
- Modify: `src/support/investigation-service.ts` — 验证专人操作消息证据，并允许其通过普通持久升级链路。
- Modify: `src/support/agent.ts` — 移除专人操作静默规则，定义缺信息追问、信息齐全转发与客服文案要求。
- Modify: `AGENTS.md` — 更新项目长期权威规则。
- Modify: `docs/agent-playbooks/diagnostics-and-replies.md` — 同步运行手册，消除“专人操作才跳过”的旧说明。
- Create temporarily, then delete: `tests/.tmp-human-operation-handoff.test.ts` — 执行 TDD 红绿验证，不进入最终提交。

### Task 1: 增加专人操作结构化类型与可信证据门禁

**Files:**
- Create temporarily: `tests/.tmp-human-operation-handoff.test.ts`
- Modify: `src/codex/schemas.ts:30,132`
- Modify: `src/support/investigation-service.ts:91-94,501-513,790-798`

**Interfaces:**
- Consumes: 现有 `AnswerDecision`、`answerDecisionJsonSchema`、`hasVerifiedTechnicalEscalation(decision, snapshot)`。
- Produces: `escalationType: "human_operation"`；`hasVerifiedTechnicalEscalation` 对 `[专人操作]` 且含 confirmed message evidence 的决定返回 `true`。

- [ ] **Step 1: 写入临时失败测试**

使用 `apply_patch` 创建 `tests/.tmp-human-operation-handoff.test.ts`：

```ts
import { describe, expect, it } from "vitest"

import {
  answerDecisionJsonSchema,
  answerDecisionSchema,
  type AnswerDecision,
} from "../src/codex/schemas.js"
import { hasVerifiedTechnicalEscalation } from "../src/support/investigation-service.js"

const base = {
  decision: "escalate",
  escalationType: "human_operation",
  answer: "收到 kakaxi 我已经发给技术同事处理了",
  quote: null,
  reason: "[专人操作]\n创建运营账号 账号名称=kakaxi",
  confidence: 0.99,
  usedMemoryVersionIds: [],
  interaction: {
    sentiment: "neutral",
    situation: "followup",
    underlyingNeed: "用 kakaxi 创建运营账号",
    responseStrategy: "direct_answer",
  },
  investigation: {
    summary: "已取得创建账号所需名称",
    steps: [{
      source: "message",
      title: "读取专人操作请求",
      status: "confirmed",
      evidence: "原问题要求创建运营账号 最新消息补充 kakaxi",
      conclusion: "账号名称已经齐全",
    }],
  },
} as const

describe("专人操作升级", () => {
  it("结构化 schema 和 JSON Schema 接受 human_operation", () => {
    expect(answerDecisionSchema.safeParse(base).success).toBe(true)
    const values = answerDecisionJsonSchema.properties.escalationType.enum
    expect(values).toContain("human_operation")
  })

  it("只用明确标记和可信消息证据确认专人操作", () => {
    const decision = base as unknown as AnswerDecision
    expect(hasVerifiedTechnicalEscalation(decision, null as never)).toBe(true)
    expect(hasVerifiedTechnicalEscalation({
      ...decision,
      reason: "创建运营账号 账号名称=kakaxi",
    }, null as never)).toBe(false)
    expect(hasVerifiedTechnicalEscalation({
      ...decision,
      investigation: {
        summary: "没有消息证据",
        steps: [{
          source: "inference",
          title: "模型推断",
          status: "confirmed",
          evidence: "可能需要创建账号",
          conclusion: "不能作为消息证据",
        }],
      },
    }, null as never)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行临时测试并确认正确失败**

Run: `pnpm vitest run tests/.tmp-human-operation-handoff.test.ts`

Expected: FAIL；Zod 与 JSON Schema 均不接受 `human_operation`，验证函数返回 `false`。测试必须是断言失败，不得是导入或语法错误。

- [ ] **Step 3: 最小实现结构化类型和证据门禁**

在 `src/codex/schemas.ts` 的两个 escalation enum 中，把：

```ts
["none", "code_defect", "technical_change", "feature_request", "service_handoff"]
```

改为：

```ts
["none", "code_defect", "technical_change", "feature_request", "service_handoff", "human_operation"]
```

在 `src/support/investigation-service.ts` 的固定 reason patterns 中增加：

```ts
const verifiedHumanOperationPattern = /^\[专人操作\](?:\s|$)/u
```

在 `hasVerifiedTechnicalEscalation` 的 `feature_request` 分支之后加入：

```ts
  if (decision.escalationType === "human_operation") {
    if (!verifiedHumanOperationPattern.test(decision.reason)) return false
    return decision.investigation.steps.some((step) => (
      step.source === "message" && step.status === "confirmed" && step.evidence.trim().length > 0
    ))
  }
```

在 `unsafeOperatorAnswer` 的非故障升级排除条件中加入：

```ts
          && decision.escalationType !== "human_operation"
```

保持 `verifiedEscalation` 的现有分派不变：`human_operation` 走 `hasVerifiedTechnicalEscalation`，`service_handoff` 继续走自己的验证函数。

- [ ] **Step 4: 运行临时测试确认通过**

Run: `pnpm vitest run tests/.tmp-human-operation-handoff.test.ts`

Expected: PASS，2 tests passed。

- [ ] **Step 5: 运行已有升级与转发回归**

Run: `pnpm vitest run tests/support/technical-escalation.test.ts tests/support/human-takeover.test.ts`

Expected: PASS；现有代码缺陷、技术变更、产品需求、跨服务接管、原消息转发、delivery 与 ownership 用例全部保持通过。

### Task 2: 更新模型决策与客服承接规则

**Files:**
- Modify temporarily: `tests/.tmp-human-operation-handoff.test.ts`
- Modify: `src/support/agent.ts:89-143`
- Modify: `AGENTS.md:65,71-72`
- Modify: `docs/agent-playbooks/diagnostics-and-replies.md:25`

**Interfaces:**
- Consumes: Task 1 的 `human_operation` 结构化类型与验证门禁。
- Produces: 回答提示明确区分缺信息的 `reply` 与信息齐全的 `human_operation`，并要求模型生成确认收到、安抚、已通知但不虚构完成结果的现场回复。

- [ ] **Step 1: 扩展临时测试以检查最终提示词**

在临时测试中增加 import：

```ts
import type { CodexExecutor } from "../src/codex/executor.js"
import type { ModelPurpose } from "../src/runtime/types.js"
import { CodexSupportDecisionAgent } from "../src/support/agent.js"
import { baselineOperatorStyleProfile } from "../src/support/operator-style.js"
```

增加测试辅助函数与用例：

```ts
async function capturedPrompt(): Promise<string> {
  let prompt = ""
  const agent = new CodexSupportDecisionAgent({
    execute: async <T>(_purpose: ModelPurpose, input: { prompt: string }): Promise<T> => {
      prompt = input.prompt
      return {} as T
    },
  } as unknown as CodexExecutor)
  await agent.decide({
    service: "lakpay",
    groupName: "LakPay",
    question: "[OLD WANG]\n创建一个新的运营账号\n\n[OLD WANG]\nkakaxi",
    responseDepth: "initial",
    senderRole: null,
    scope: "lakpay",
    region: null,
    branch: "main",
    codeSnapshot: null,
    directives: [],
    memories: [],
    documents: [],
    resources: { servers: [], databases: [], checks: [] },
    attachments: [],
    resourceWorkspacePath: ".",
    resourceManifestPath: "READ_ONLY.md",
    networkHosts: [],
    answerTimeoutSeconds: 30,
    operatorStyleProfile: baselineOperatorStyleProfile,
    modelInstanceId: "00000000-0000-4000-8000-000000000001",
    modelSnapshot: {
      id: "00000000-0000-4000-8000-000000000001",
      alias: "测试回答模型",
      provider: "openai",
      transport: "codex_cli",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      serviceTier: "standard",
      parameters: {},
      apiKey: null,
      enabled: true,
      healthStatus: "not_tested",
      healthMessage: "尚未检测",
      lastCheckedAt: null,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    },
    answerMaxConcurrency: 2,
    answerBindingEnabled: true,
    replyStyle: "human",
  })
  return prompt
}

it("提示词要求专人操作缺信息追问 齐全后确认并真实转发", async () => {
  const prompt = await capturedPrompt()
  expect(prompt).toContain("human_operation")
  expect(prompt).toContain("[专人操作]")
  expect(prompt).toContain("缺少执行所需的最少业务标识")
  expect(prompt).toContain("确认收到")
  expect(prompt).toContain("不得声称操作已经完成")
  expect(prompt).not.toContain("用户解冻、创建账号等明确由专人执行的操作，以及能够明确判断为闲聊或无需客服介入的协调消息，decision=ignore")
})
```

- [ ] **Step 2: 运行临时测试并确认提示词断言失败**

Run: `pnpm vitest run tests/.tmp-human-operation-handoff.test.ts`

Expected: FAIL；提示词没有 `human_operation`、`[专人操作]` 和新决策要求，且仍包含旧 `decision=ignore` 规则。

- [ ] **Step 3: 更新 `src/support/agent.ts`**

在 escalation type 总览中增加：

```text
明确由专人执行且执行所需最少业务标识已经齐全时使用 human_operation
```

用以下语义替换旧专人操作 ignore 规则；保持它们为独立提示行，便于测试和复核：

```text
用户解冻 创建账号等明确由专人执行的操作不能 ignore。先结合完整会话判断缺少执行所需的最少业务标识。缺少时 decision=reply escalationType=none responseStrategy=minimal_clarification 只追问当前最少需要的一项；已经齐全时 decision=escalate escalationType=human_operation 真实转发技术群接手。

human_operation 的 reason 第一行必须独占一行严格写成“[专人操作]” 下一行说明操作类型和消息中已经取得的必要标识。investigation 必须记录 confirmed message 证据 不要求为了专人操作读取代码或生产资源。

human_operation 的 answer 必须结合最新消息自然确认收到并安抚 说明已经通知技术同事接手 不得使用固定模板 不得声称账号已经创建 用户已经解冻 操作已经完成或承诺完成时间。
```

同步修改通用 `decision=escalate` 回答说明，把 `human_operation` 明确列为“确认收到、说明已通知技术接手、不虚构完成结果”。在排除普通故障升级条件的说明中加入“符合专人操作且信息齐全时按 `human_operation` 转技术”。闲聊和无需客服介入的协调消息仍可 `ignore`。

- [ ] **Step 4: 同步权威规则与运行手册**

在 `AGENTS.md` 中将旧规则统一改为：

```text
上游对接过程中的无提问沟通和明显无需回答的对话不发送客服回复。用户解冻、创建账号及其他明确由专人执行的操作不能静默忽略：缺少执行所需的最少业务标识时只追问当前最少需要的一项；信息齐全后由回答模型自然确认收到并安抚，使用独立的专人操作升级真实转发同一问题线程的完整原始 Telegram 消息到技术告警群。不得声称操作已经完成或承诺完成时间。
```

把 `AGENTS.md` 和 `docs/agent-playbooks/diagnostics-and-replies.md` 中“明确专人操作才跳过”的句子改为只允许纯聊天、对接寒暄或无需客服介入的协调内容跳过。把升级总则补充为 `human_operation` 不要求代码或运行证据，只要求完整消息中的实际操作请求和必要标识。

- [ ] **Step 5: 运行临时测试确认全部通过**

Run: `pnpm vitest run tests/.tmp-human-operation-handoff.test.ts`

Expected: PASS，3 tests passed。

- [ ] **Step 6: 检查旧规则已完全移除**

Run: `rg -n "专人操作才跳过|创建账号等明确由专人执行的操作.*decision=ignore|用户解冻/创建等有专人处理的操作.*不发送" AGENTS.md src/support/agent.ts docs/agent-playbooks`

Expected: 无输出。

### Task 3: 完整验证、删除临时测试并提交

**Files:**
- Delete: `tests/.tmp-human-operation-handoff.test.ts`
- Verify: `src/codex/schemas.ts`
- Verify: `src/support/investigation-service.ts`
- Verify: `src/support/agent.ts`
- Verify: `AGENTS.md`
- Verify: `docs/agent-playbooks/diagnostics-and-replies.md`

**Interfaces:**
- Consumes: Task 1 与 Task 2 的完整实现。
- Produces: 不包含测试代码的可构建提交，以及所有现有相关测试和类型检查的最新验证证据。

- [ ] **Step 1: 删除临时测试文件**

使用 `apply_patch` 删除 `tests/.tmp-human-operation-handoff.test.ts`。

- [ ] **Step 2: 确认最终 diff 没有测试代码**

Run: `git status --short && git diff --name-only && git diff --check`

Expected: 只列出 `AGENTS.md`、`docs/agent-playbooks/diagnostics-and-replies.md`、`src/codex/schemas.ts`、`src/support/agent.ts`、`src/support/investigation-service.ts`；`git diff --check` 无输出并退出 0。

- [ ] **Step 3: 运行相关现有测试**

Run: `pnpm vitest run tests/support/technical-escalation.test.ts tests/support/human-takeover.test.ts tests/support/response-depth.test.ts tests/support/operator-voice.test.ts`

Expected: PASS，0 failed。

- [ ] **Step 4: 运行完整类型检查与构建**

Run: `pnpm typecheck && pnpm build`

Expected: 两条命令均退出 0；服务端和前端 TypeScript 构建无错误。

- [ ] **Step 5: 复核需求与持久转发路径**

Run:

```bash
rg -n "human_operation|\[专人操作\]|forwardMessages|alert_kind='escalation'|technical_alert:escalation" \
  AGENTS.md src/codex/schemas.ts src/support/agent.ts src/support/investigation-service.ts \
  src/support/answer-worker.ts src/support/technical-alert-service.ts
```

Expected:

- 新类型同时存在于 Zod、JSON Schema、提示词和可信证据验证中。
- `answer-worker` 仍只对 `feature_request` 使用瞬时分支，`human_operation` 落入普通持久 `escalate`。
- `technical-alert-service` 的普通 `escalation` 仍调用 `forwardMessages` 并使用 `technical_alert:escalation` ownership。

- [ ] **Step 6: 提交实现**

```bash
git add AGENTS.md docs/agent-playbooks/diagnostics-and-replies.md \
  src/codex/schemas.ts src/support/agent.ts src/support/investigation-service.ts
git commit -m "客服：专人操作确认后转发技术群"
```

Expected: 提交成功，提交中不包含 `tests/` 文件。

## Code Review Hardening

提交前审查发现，系统会为每次调查自动注入通用 confirmed message 步骤，因此仅检查该步骤不能证明专人操作的必要标识已经齐全。最终实现需要在上述步骤之外完成以下加固：

- 为 JSON Schema 增加必填但可空的 `humanOperation`；`human_operation` 必须填写逐字来自原线程的 `action` 和至少一个 `identifiers`，其他类型必须为 `null`。
- `hasVerifiedTechnicalEscalation` 接收完整 `question`，逐项确认 action 与 identifiers 存在于原线程；identifier 必须唯一、不属于 action、在移除 action 后仍然出现，并拒绝泛化或类别标识。
- `human_operation` 使用严格完成态通知检查；“需要通知”“稍后通知”不能通过，只有明确“已/已经通知、转给、发给”或“技术已收到/接手”才可发送。“账号已经创建、用户已经解冻、操作已经完成、技术已经处理”等未经证实的完成声明一律阻断。
- 通用代码排查提示明确排除 `human_operation`。专人操作仍使用当前快照保持任务和服务归属稳定，但不读取代码内容，也不要求代码或生产证据。
