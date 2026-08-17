# Deep Causal Investigation and Friendly Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 客服在回复前追到可验证根源，以专业亲切的自然口语回复，并在确认需要技术写操作时先尝试发送技术告警、再向运营统一回复已通知。

**Architecture:** 保留现有单 Agent 和自主只读工具循环，在结构化回答中增加升级类型，并由调查服务基于可信代码与运行步骤校验升级。固定规则种子、运行提示和项目权威记忆同步更新；回答工作器按“告警尝试 → 唯一运营回复”顺序执行，并在后台保存真实告警投递结果。

**Tech Stack:** TypeScript 5.9、Node.js 22、Zod 4、SQLite、Fastify、Vitest、Telegram Bot/Teleproto transport。

## Global Constraints

- 对升级证据、alert-first 顺序和崩溃恢复严格执行 TDD；补充聚焦行为测试后再运行全量测试、类型检查和构建。
- 四方支付代码、MagicBook、生产服务器和生产数据库只读；本次只修改当前项目代码和文档。
- 不引入固定表名、固定日志路径或固定调查顺序。
- 运营群只发送一条升级回复；不发送“我去通知技术”之类中间状态。
- 技术告警无论成功、未配置、失败或结果不确定，运营升级文案都追加“我已经通知技术同事处理了”；后台必须保留真实投递结果。
- Git 提交信息、推送说明和状态反馈使用中文。
- 保留现有出站敏感信息阻断、代码缺陷文件行号校验和生产只读边界。

---

### Task 1: Extend structured decisions and trusted escalation validation

**Files:**
- Modify: `src/codex/schemas.ts`
- Modify: `src/support/investigation-service.ts`

**Interfaces:**
- Produces: `AnswerEscalationType = "none" | "code_defect" | "technical_change"` through `AnswerDecision["escalationType"]`.
- Produces: `hasVerifiedTechnicalEscalation(decision: AnswerDecision, snapshot: ProjectCodeSnapshot): boolean`.
- Consumes: trusted investigation steps rebuilt by `SupportInvestigationService.trustedInvestigation`.

- [ ] **Step 1: Add the escalation type to both Zod and JSON schemas**

Add a required `escalationType` field:

```ts
escalationType: z.enum(["none", "code_defect", "technical_change"]),
```

Update `superRefine` so `reply` and `escalate` require a non-empty `answer`, `escalate` requires a non-`none` type, and non-escalation decisions require `none`. Change the transform so only `ignore` clears `answer` and `quote`; an escalation must retain its root-cause answer for the worker.

Add the same required enum to `answerDecisionJsonSchema` so every provider uses the same strict output contract.

- [ ] **Step 2: Update internal AnswerDecision literals**

In `src/support/investigation-service.ts`, add `escalationType: "none"` to deterministic reply, implicit-help and fallback objects. Do not assign a technical escalation type to timeout, missing-evidence or safety fallback decisions.

- [ ] **Step 3: Validate technical changes from trusted evidence**

Keep `hasVerifiedCodeDefect` for `code_defect`. Add a validator with these exact gates:

```ts
const verifiedTechnicalChangePattern = /^\[已确认技术处理\]\s*类型=(?:生产配置|后台映射|后台数据|服务操作)(?:\s|$)/u

export function hasVerifiedTechnicalEscalation(
  decision: AnswerDecision,
  snapshot: ProjectCodeSnapshot,
): boolean {
  if (decision.decision !== "escalate") return false
  if (decision.escalationType === "code_defect") return hasVerifiedCodeDefect(decision, snapshot)
  if (decision.escalationType !== "technical_change") return false
  if (!verifiedTechnicalChangePattern.test(decision.reason)) return false
  const readCode = decision.investigation.steps.some((step) => (
    step.source === "code" && step.status === "confirmed" && step.title === "执行代码只读检查"
  ))
  const readRuntime = decision.investigation.steps.some((step) => (
    ["server", "log", "database", "redis"].includes(step.source) && step.status === "confirmed"
  ))
  return readCode && readRuntime
}
```

The initial code snapshot metadata and nginx precheck alone must not satisfy `technical_change`; the model must have an actual trusted code-read command plus a confirmed runtime observation.

- [ ] **Step 4: Replace the escalation retry gate**

Replace the current `decision.decision === "escalate" && !hasVerifiedCodeDefect(...)` condition with `!hasVerifiedTechnicalEscalation(...)`. Update retry and fallback wording from “没有当前代码文件证据不得升级” to “没有已确认根源和符合升级类型的可信证据不得升级”.

- [ ] **Step 5: Run static verification**

Run:

```bash
pnpm typecheck
```

Expected: TypeScript reports every still-missing `escalationType`; update only existing production code literals, then rerun until it exits 0.

- [ ] **Step 6: Commit schema and validation**

```bash
git add src/codex/schemas.ts src/support/investigation-service.ts
git commit -m "功能：增加技术处理升级证据校验"
```

### Task 2: Align project rules, locked directives, and runtime prompts

**Files:**
- Modify: `AGENTS.md`
- Modify: `src/runtime/knowledge-service.ts`
- Modify: `src/support/agent.ts`
- Modify: `src/support/operator-copy.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `AnswerDecision.escalationType` from Task 1.
- Produces: system directives automatically replaced by `ensureSystemDirectives()` on the next service start.
- Produces: `operatorCopy.technicalNotified` for Task 3.

- [ ] **Step 1: Update the authoritative investigation rule**

In `AGENTS.md`, extend the existing autonomous investigation requirements with the causal completion rule:

```text
直接请求字段 错误响应 订单状态和失败日志只算直接现象 不能自动当成最终原因
当结果由代码 配置 映射 模板或业务数据派生时 必须沿当前代码反查最终结果 字段转换 配置数据和原始输入
只要当前绑定服务还有合理且安全的只读证据路径就继续排查 不能把还要再看或需要再确认作为最终回复
只有证据排除其他合理分支后才确定根源 实际尝试全部合理路径后仍缺外部信息时才追问最少一项
```

Replace the old “only code defects escalate” rule with the approved boundary: confirmed internal code, production configuration, channel mapping or backend data changes may escalate; merchant omissions, upstream faults, normal state, uncertainty and resource failure do not.

- [ ] **Step 2: Update locked system directive seeds**

In `systemDirectiveSeeds`:

- Expand `自主只读排查` with the same causal chain and stopping rule.
- Expand `运营群自然回复` so the AI is a professional, warm and patient customer-service colleague using natural phrases such as “我看了下” and “麻烦发下”, without fixed greetings or canned apologies.
- Replace `技术群只收告警` content with the new confirmed technical-action boundary and the single-message operator behavior.

Keep all directive scopes `global` and preserve existing priorities unless two directives would conflict; `自主只读排查` remains priority 99.

- [ ] **Step 3: Update the answer-agent prompt**

In `CodexSupportDecisionAgent.decide`:

- Define `escalationType=none` for reply/ignore.
- Define `code_defect` only for the existing verified file-and-line defect format.
- Define `technical_change` only when the root cause is confirmed, internal, needs a technical write, and the run contains an actual code read plus confirmed runtime evidence.
- Require technical-change reasons to start with `[已确认技术处理] 类型=<生产配置|后台映射|后台数据|服务操作>`.
- Require escalation `answer` to contain the concrete root cause and processing need, but not “已通知”; the worker owns that suffix.
- Replace “只有代码缺陷才允许 escalate” with the approved escalation boundary.
- Add the generic backward chain `最终结果 ← 字段转换或状态流转 ← 配置与业务数据 ← 原始输入` and forbid finishing at a downstream symptom while evidence paths remain.
- Describe the professional, warm, natural customer-service role without fixed “您好” or “感谢理解” openings.

- [ ] **Step 4: Replace the generic escalation copy**

Change `src/support/operator-copy.ts` from a generic uncertain escalation to a suffix owned by the worker:

```ts
technicalNotified: "我已经通知技术同事处理了",
```

Remove or stop using `operatorCopy.escalation`; no escalation reply may say the root cause is still unconfirmed.

- [ ] **Step 5: Update README behavior summary**

Document that the AI traces derived symptoms to root causes, escalates confirmed internal technical changes, attempts the technical alert first, and sends one professional, warm operator reply. State that the backend retains the real alert delivery result even though the approved operator copy always says notified.

- [ ] **Step 6: Verify directive consistency**

Run:

```bash
rg -n "只有.*代码.*升级|没有当前代码文件证据不得升级|这个问题还不能直接确认 我再跟进|我去通知技术" AGENTS.md README.md src
```

Expected: no active rule or prompt retains the removed code-only boundary or old generic escalation copy. Historical migration strings are acceptable only if not loaded at runtime.

- [ ] **Step 7: Commit rules and prompts**

```bash
git add AGENTS.md README.md src/runtime/knowledge-service.ts src/support/agent.ts src/support/operator-copy.ts
git commit -m "调整：客服深入排查并采用亲切口吻"
```

### Task 3: Send technical alerts before the single operator reply

**Files:**
- Modify: `src/support/answer-worker.ts`
- Modify: `src/replies/reply-service.ts`
- Modify: `src/support/technical-alert-service.ts`
- Modify: `src/support/thread-store.ts`
- Modify: `tests/support/human-takeover.test.ts`

**Interfaces:**
- Consumes: retained escalation `decision.answer`, `decision.escalationType`, trusted `decision.reason`, and `operatorCopy.technicalNotified`.
- Consumes: `TechnicalAlertService.sendSupportAlert(...) -> TechnicalAlertDelivery`.
- Produces: one operator message and one persisted `技术告警：<summary>` delivery marker per escalation attempt.

- [ ] **Step 1: Pass the full decision into the escalation path**

Change `applyDecision` to pass `decision` into `escalate` instead of separate reason, confidence and memory arrays. Preserve the existing memory-reference allowlist.

- [ ] **Step 2: Build the one final operator answer safely**

Inside `escalate`, humanize `decision.answer` only for `group.replyStyle === "human"`, then append exactly one line:

```ts
const operatorAnswer = `${rootCauseAnswer.trim()}\n${operatorCopy.technicalNotified}`
```

Run the combined value through `assertSafeOutbound`. If it is blocked or empty, use a safe escalation fallback that still says the confirmed issue requires technical handling and has been notified, without exposing the blocked detail.

- [ ] **Step 3: Attempt the technical alert before touching the operator group**

Call:

```ts
const alert = await this.deps.technicalAlerts.sendSupportAlert(
  group,
  replyId,
  decision.reason,
  operatorAnswer,
)
```

Do this while the reply record is still `generating`. Do not send any operator message before this call finishes. All delivery statuses continue to the same operator copy.

- [ ] **Step 4: Persist the alert result and send exactly one operator message**

After the alert attempt, transition the record to `sending` with:

```ts
decisionReason: `${decision.reason}\n技术告警：${alert.summary}`.slice(0, 2000)
```

Send `operatorAnswer` once as a reply to the original anchor, then transition to `escalated` with the Telegram message ID. Do not send a pre-notification message.

- [ ] **Step 5: Persist a separate operator-delivery-failure alert**

In the `current.status === "sending"` error path, transition the operator delivery to its real failed or uncertain state, then independently claim `support_delivery_failure` in the persistent alert-delivery table. Send that supplemental alert even when the earlier `escalation` alert succeeded, because the technical group must know the operator group did not receive the final reply. Use the two distinct persisted alert kinds for idempotency; never infer delivery state from `decisionReason` text.

- [ ] **Step 6: Add focused recovery coverage and run verification**

Cover the alert-first and operator-delivery crash windows with persistent delivery/ownership fixtures. In particular, distinguish a pre-RPC claim with no ownership from an in-flight RPC with sending/sent/unknown ownership, and prove supplemental alerts can resume without resending the operator reply.

Run:

```bash
pnpm typecheck
pnpm build
pnpm test
```

Expected: focused recovery tests first fail for the missing behavior, then pass with the implementation; all verification commands exit 0.

- [ ] **Step 7: Commit delivery flow**

```bash
git add src/replies/reply-service.ts src/support/answer-worker.ts src/support/technical-alert-service.ts src/support/thread-store.ts tests/support/human-takeover.test.ts
git commit -m "功能：技术告警后统一回复运营"
```

### Task 4: Final cross-layer verification

**Files:**
- Verify only: all files modified in Tasks 1-3

**Interfaces:**
- Consumes: complete implementation from Tasks 1-3.
- Produces: verified build and clean scoped diff ready for deployment preparation.

- [ ] **Step 1: Inspect the complete diff**

Run:

```bash
git diff HEAD~3 -- AGENTS.md README.md src/codex/schemas.ts src/runtime/knowledge-service.ts src/support/agent.ts src/support/investigation-service.ts src/support/operator-copy.ts src/support/answer-worker.ts
```

Check that merchant omissions remain replies, confirmed mapping/configuration changes can escalate, the model cannot escalate from uncertainty, and only the worker adds the notified suffix.

- [ ] **Step 2: Run final verification from a clean command invocation**

Run:

```bash
pnpm typecheck && pnpm build && pnpm test
```

Expected: all existing checks pass with exit code 0.

- [ ] **Step 3: Confirm unrelated files remain untouched**

Run:

```bash
git status --short
```

Expected: the pre-existing untracked `tests/knowledge/interface-scope.test.ts` remains untracked and was not staged or modified. No temporary artifacts are staged.

- [ ] **Step 4: Report deployment boundary**

Do not start or restart the local resident service. Report that the locked SQLite directives update on the next configured Linux service start through `ensureSystemDirectives`, and that deployment/online verification still requires the user-designated Linux server.
