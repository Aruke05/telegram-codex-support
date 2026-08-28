# Transaction Evidence Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 阻止客服把仅金额或时间相近、但交易类型、服务、商户或通道不一致的候选记录当作用户正在询问的同一笔交易，并确保所有具体交易运行事实在发送前经过结构关联门禁和独立审核。

**Architecture:** 将调查模型输出升级为 `EvidencePacket` v2，显式描述事实主体、稳定标识、候选线索、交易关联、冲突和推断依赖。新增纯函数门禁对这些声明做中立的结构验证和安全降级；`InvestigationService` 根据结构化事实决定是否进入严格审核，严格链路只有“基线审核通过”或“修订后审核通过”两种可发送结果，任何审核失败都不再退回未经审核的基线。

**Tech Stack:** Node.js >=22.16、TypeScript、Zod、Vitest、SQLite `node:sqlite`、现有 Codex/Direct API 严格 JSON Schema 模型适配器。

**Spec:** `docs/superpowers/specs/2026-08-27-transaction-evidence-binding-design.md`

## Global Constraints

- 不修改 DevaPay 或其他支付项目、生产数据库、生产业务配置；生产资源仅允许只读核验。
- 不用 XDPay、AOHPay、订单前缀、错误码、金额范围、关键词、正则、分数或相似度在代码中判断业务类型、责任、根因、是否升级或是否回复。
- 金额、时间、收款人、账户、商户和通道只是 `lookupHints`；只有允许的稳定标识在两个不同非推断来源中完全一致，才能确认交易关联。
- 父进程只验证模型声明的结构关系，不替代模型理解业务；证据不足时回复内容仍由模型生成。
- 保持线程 30 分钟归档、输入版本作废、人工接管、进度提示、发送所有权、告警投递和重启恢复语义不变。
- 不增加 SQLite schema 版本或新表；`reply_generation_audits` 继续存放不透明 JSON，流水线版本升级为 `evidence-binding-review-v2`。
- 当前主工作区已有用户未提交改动；所有实施在隔离 worktree 中进行，不能覆盖、回退或夹带这些改动。

---

### Task 1: EvidencePacket v2 严格协议与兼容解析

**Files:**
- Modify: `src/codex/schemas.ts`
- Create: `tests/codex/transaction-evidence-schema.test.ts`

**Interfaces:**
- Produces: `stableIdentifierKindSchema`, `lookupHintKindSchema`, `evidenceIdentifierSchema`
- Produces: `evidenceAssociationSchema`, `EvidenceAssociation`
- Produces: `EvidenceFact.subjectKind`, `businessType`, `identifiers`, `associationId`, `dependsOnFactIds`
- Produces: `EvidencePacket.version = "2"` and `EvidencePacket.associations`
- Produces: `AnswerClaim.factId`
- Preserves: legacy persisted/test decision parsing through an explicitly named compatibility schema or normalization boundary; production `answerDecisionJsonSchema` requires all v2 fields and `answerClaims[].factId`

- [ ] **Step 1: Write failing schema tests**

Cover a complete v2 decision, all five stable identifier kinds, all six lookup hints, exact case/leading-zero preservation, association IDs matching `A1`-`A24`, duplicate fact/association IDs, missing copyable recipient, inference without dependencies, and production JSON Schema required fields. Add one compatibility test showing a persisted v1 decision can still be read without making v1 valid model output.

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
pnpm exec vitest run tests/codex/transaction-evidence-schema.test.ts
```

Expected: FAIL because v2 fact/association fields and `answerClaims[].factId` do not exist.

- [ ] **Step 3: Add minimal Zod types and JSON Schema**

Use strict objects and bounded arrays. Stable identifier values receive only `.trim()` and are never lowercased or punctuation-normalized. Require `dependsOnFactIds` for `certainty=inferred`, `evidenceSource=inference`, or `provenance=inference`. Require `associations` in production model output and require `factId` on every production answer claim.

- [ ] **Step 4: Add a narrow compatibility boundary**

Do not weaken `answerDecisionJsonSchema`. If existing persisted decisions/tests require v1 input, parse them through a named legacy schema/normalizer that fills only structural defaults and never marks a legacy transaction as confirmed. Keep new runtime model output v2-only.

- [ ] **Step 5: Run schema tests and typecheck**

```bash
pnpm exec vitest run tests/codex/transaction-evidence-schema.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/codex/schemas.ts tests/codex/transaction-evidence-schema.test.ts
git commit -m "重构：升级交易证据协议"
```

### Task 2: 纯结构交易关联门禁

**Files:**
- Create: `src/support/evidence-binding-gate.ts`
- Create: `tests/support/evidence-binding-gate.test.ts`

**Interfaces:**
- Produces: `applyEvidenceBindingGate(input: EvidenceBindingGateInput): EvidenceBindingGateResult`
- Produces: `EvidenceBindingGateResult.packet`, `issues`, `strictReviewRequired`
- Produces: `EvidenceBindingStructuralError` for duplicate/missing references and dependency cycles
- Consumes: v2 `EvidencePacket`, `AnswerClaim[]`, `ResponsibilityAssessment`

- [ ] **Step 1: Write the complete gate decision matrix as failing tests**

Cover:

- the same merchant order number in a message/display fact and database/runtime fact confirms association;
- the same system order number in a callback and database fact confirms association;
- amount-only, time-only, merchant-only and channel-only hints cannot confirm;
- business type, service, merchant, channel and identifier conflicts normalize to `conflicting`;
- a matched identifier must occur verbatim in both referenced facts, with the same kind/value, distinct fact IDs and distinct non-inference sources;
- one stable identifier mapped to multiple distinct system order numbers becomes conflicting unless the packet explicitly resolves it with non-conflicting facts;
- missing fact/association/dependency references, duplicate IDs and dependency cycles throw `EvidenceBindingStructuralError`;
- unconfirmed/conflicting transaction facts become `outboundSafe=false`;
- unsafe state propagates through transitive inference dependencies;
- an answer claim citing a missing or unsafe fact becomes a gate issue and cannot be sent;
- strict review is structurally selected for transaction associations, request/response/callback/runtime claims, dependent inference claims, and non-unknown responsibility.

- [ ] **Step 2: Run the gate test and confirm RED**

```bash
pnpm exec vitest run tests/support/evidence-binding-gate.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement graph validation before trust decisions**

Index facts and associations, reject duplicate IDs and unknown references, and perform depth-first cycle detection over `dependsOnFactIds`. Return deterministic issue ordering by association/fact/claim input order so audits and tests remain stable.

- [ ] **Step 4: Implement association validation and safe downgrade**

Validate only the declared identifier types/values and provenance fields. A `confirmed` association without a valid two-source match becomes `unconfirmed`; any declared unresolved conflict becomes `conflicting`. Mark every transaction fact attached to a non-confirmed association unsafe, then propagate unsafe status to dependent inferences until fixed point.

- [ ] **Step 5: Implement claim validation and strict-review selection**

Require every answer claim to cite one existing outbound-safe fact. Do not inspect claim text. Compute strict-review need only from association presence, provenance/dependency graph, and responsibility structure.

- [ ] **Step 6: Run tests, typecheck, and commit**

```bash
pnpm exec vitest run tests/support/evidence-binding-gate.test.ts
pnpm typecheck
git add src/support/evidence-binding-gate.ts tests/support/evidence-binding-gate.test.ts
git commit -m "功能：增加交易证据关联门禁"
```

### Task 3: 信任化证据与严格回复流水线

**Files:**
- Modify: `src/support/investigation-service.ts`
- Modify: `src/support/agent.ts`
- Modify: `tests/support/reply-pipeline.test.ts`
- Modify: `tests/runtime/reply-generation-audit.test.ts`

**Interfaces:**
- Consumes: `applyEvidenceBindingGate`
- Changes: audit pipeline version to `evidence-binding-review-v2`
- Changes: strict transaction/runtime decisions enter independent review even when communication intent is `direct_answer` or `minimal_clarification`
- Preserves: non-strict ordinary direct answers avoid unnecessary compose/review calls

- [ ] **Step 1: Replace old fallback expectations with failing safety tests**

Add/adjust tests for:

- a strict direct answer receives independent review;
- a safe strict baseline approved on the first review is returned without composition;
- a gate downgrade never returns the baseline and invokes exactly one composer revision;
- first review `revise` invokes one composer revision and one second review;
- revised answer is returned only after second review `approve`;
- second review `revise`/`prefer_baseline`, composer failure, review failure, invalid claims or unsafe facts throw `SupportModelOutputRejectedError`;
- no strict failure path returns an unreviewed baseline;
- an ordinary non-transaction direct answer remains on the single-model fast path;
- audit records capture gate issues, both reviews, final source, and v2 version without a DB migration.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
pnpm exec vitest run tests/support/reply-pipeline.test.ts tests/runtime/reply-generation-audit.test.ts
```

Expected: FAIL on current `copyable_message`-only review and baseline fallback behavior.

- [ ] **Step 3: Gate the trusted evidence packet**

After existing source confirmation/redaction, call the pure gate. Structural errors must surface through the existing model-structure retry path. Safe downgrade issues become revision feedback and make the baseline ineligible for fallback. Preserve allowed memory IDs and sensitivity filters.

- [ ] **Step 4: Split baseline review from optional rewrite**

For strict cases, review the baseline first using its `answerClaims[].factId`. If approved, return the baseline. If revision is needed or the gate produced safe issues, call `composeReply` exactly once using only gated outbound facts and explicit issues, validate the composed claims with the gate, and review exactly once more. Throw on every remaining failure.

- [ ] **Step 5: Tighten model prompts without fixed customer copy**

Update investigation, composer and reviewer prompts to produce v2 facts/associations, distinguish stable identifiers from lookup hints, cite each claim, reject cross-business/cross-channel candidates, and preserve unknown boundaries. Prompts must not include a hard-coded XDPay/AOHPay branch or a fixed final sentence.

- [ ] **Step 6: Preserve audit compatibility**

Write `evidence-binding-review-v2` into the existing audit table and JSON payload. Update audit tests only for new rows; keep old v1 audit rows readable/exportable.

- [ ] **Step 7: Run focused tests, typecheck, and commit**

```bash
pnpm exec vitest run tests/support/reply-pipeline.test.ts tests/runtime/reply-generation-audit.test.ts tests/admin-chat/worker.test.ts
pnpm typecheck
git add src/support/investigation-service.ts src/support/agent.ts tests/support/reply-pipeline.test.ts tests/runtime/reply-generation-audit.test.ts
git commit -m "修复：阻断未审核交易事实回复"
```

### Task 4: 固定规则单一来源与 Deva 事故情景回归

**Files:**
- Modify: `AGENTS.md`
- Modify: `src/support/system-directives.ts`
- Modify: `src/support/agent.ts`
- Create: `tests/fixtures/deva-transaction-mismatch.ts`
- Create: `tests/support/transaction-evidence-scenarios.test.ts`
- Modify: `tests/support/system-directives.test.ts`

**Interfaces:**
- Produces: one authoritative fixed directive covering stable transaction association and candidate-only hints
- Produces: a fully synthetic/de-identified Deva mismatch fixture with no credential, raw attachment, full request, signature or connection data

- [ ] **Step 1: Write failing fixed-rule and scenario tests**

Build a semantic matrix with:

- Deva incident: user display says XDPay/collection/100; candidate says AOHPay/payment/100; no shared stable ID; expected `conflicting`, candidate order facts unsafe, and forbidden claims about configuration success or caller parsing;
- safe positive control: a merchant order ID appears in the user message and current-service database, with matching business/channel declarations; expected confirmed and answerable;
- same amount and close timestamp without an ID; expected unconfirmed and minimal identifier request/boundary;
- a screenshot stable ID plus runtime fact with the same ID but a declared channel conflict; expected conflicting;
- a bank reference treated as stable only when a code/runtime fact explicitly establishes the field meaning.

Assert structure and forbidden/required semantic categories, not exact Chinese prose.

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm exec vitest run tests/support/transaction-evidence-scenarios.test.ts tests/support/system-directives.test.ts
```

- [ ] **Step 3: Add the fixed rule once and compile it into prompts**

Place the durable rule in the established fixed-rule authority used by `system-directives.ts`; make `agent.ts` consume that compiled rule and keep only protocol-specific instructions locally. Avoid duplicating customer wording across files.

- [ ] **Step 4: Add the synthetic scenario fixture and pass the matrix**

The Deva fixture may retain product/channel labels needed to reproduce the mismatch but must use invented order IDs and timestamps. Never store copied production messages, screenshots, connection details or full payloads.

- [ ] **Step 5: Run focused tests, typecheck, and commit**

```bash
pnpm exec vitest run tests/support/transaction-evidence-scenarios.test.ts tests/support/system-directives.test.ts tests/support/operator-voice.test.ts tests/support/response-depth.test.ts
pnpm typecheck
git add AGENTS.md src/support/system-directives.ts src/support/agent.ts tests/fixtures/deva-transaction-mismatch.ts tests/support/transaction-evidence-scenarios.test.ts tests/support/system-directives.test.ts
git commit -m "规则：要求交易事实稳定标识关联"
```

### Task 5: 生命周期与发送完整性回归

**Files:**
- Modify: `tests/support/reply-pipeline.test.ts`
- Modify: `tests/support/human-takeover.test.ts`
- Modify: `tests/support/response-depth.test.ts`
- Modify: `tests/replies/reply-service.test.ts` if the existing ownership scenarios live there
- Modify: `src/support/answer-worker.ts` only if a failing lifecycle test demonstrates a real integration gap

**Interfaces:**
- Preserves: revision check and `superseded` state during both review passes
- Preserves: human takeover cancellation and no-send behavior
- Preserves: one-time progress message and failure-to-technical closeout
- Preserves: Telegram `sent`/`unknown` ownership anti-duplication across restart

- [ ] **Step 1: Add failing concurrency tests around the longer strict pipeline**

Cover a new message arriving during first review, during composition and during second review; human takeover during each stage; progress already sent followed by `SupportModelOutputRejectedError`; sending RPC started before supersession; and restart recovery after `unknown` ownership.

- [ ] **Step 2: Run the lifecycle suite and inspect failures**

```bash
pnpm exec vitest run tests/support/reply-pipeline.test.ts tests/support/human-takeover.test.ts tests/support/response-depth.test.ts tests/replies/reply-service.test.ts
```

- [ ] **Step 3: Make only demonstrated integration fixes**

Keep strict review inside the existing abort signal and generation task. Recheck revision, terminal thread status and output ownership immediately before Telegram RPC. Route model rejection through the existing persistent failure/handoff behavior; do not invent a new customer fallback message.

- [ ] **Step 4: Run lifecycle tests, typecheck, and commit**

```bash
pnpm exec vitest run tests/support/reply-pipeline.test.ts tests/support/human-takeover.test.ts tests/support/response-depth.test.ts tests/replies/reply-service.test.ts tests/support/technical-escalation.test.ts
pnpm typecheck
git add src/support/answer-worker.ts tests/support tests/replies/reply-service.test.ts
git commit -m "测试：覆盖交易审核生命周期"
```

Only add `src/support/answer-worker.ts` if it changed; do not stage unrelated files through broad globs when committing.

### Task 6: 聚焦历史回放与安全报告

**Files:**
- Modify: `scripts/run-reply-regression.mjs`
- Create: `tests/scripts/reply-regression-focus.test.ts`
- Create: `docs/superpowers/reports/.gitkeep` only if the report directory is not ignored and repository convention requires it

**Interfaces:**
- Adds: `--focus-case-id <id>` repeatable selector or equivalent bounded selector using already loaded SQLite rows
- Adds: report fields `evidencePacketVersion`, `associationStatuses`, `unsafeClaimCount`, `strictReviewOutcome`
- Preserves: no Telegram output adapter and read-only copied SQLite input

- [ ] **Step 1: Write a failing CLI/report test**

Use a temporary synthetic SQLite database containing the three incident-shaped thread segments and two safe controls. Assert focused selection excludes unrelated rows, report output is de-identified, unsafe transaction claims are counted, and no original attachment/body/credential is written.

- [ ] **Step 2: Run the focused script test and confirm RED**

```bash
pnpm exec vitest run tests/scripts/reply-regression-focus.test.ts
```

- [ ] **Step 3: Add bounded focus selection and report fields**

Reuse existing sampling and model execution. Do not add a broad production crawler. Require an explicit copied database path and write reports only to a temporary or explicitly supplied output path.

- [ ] **Step 4: Run synthetic replay and commit**

```bash
pnpm exec vitest run tests/scripts/reply-regression-focus.test.ts
node scripts/run-reply-regression.mjs --help
git add scripts/run-reply-regression.mjs tests/scripts/reply-regression-focus.test.ts
git commit -m "测试：增加交易错配聚焦回放"
```

### Task 7: 全量验证、隔离启动与只读生产抽样

**Files:**
- Review only: all changed files
- Output outside Git: temporary test database, replay JSON and build logs

- [ ] **Step 1: Verify the worktree and diff scope**

```bash
git status --short
git diff --check HEAD~5..HEAD
git diff --stat HEAD~5..HEAD
```

Confirm no credential, production attachment, full production message, private key, database connection, deployment host secret or unrelated user change is present.

- [ ] **Step 2: Run focused safety suites**

```bash
pnpm exec vitest run tests/codex/transaction-evidence-schema.test.ts tests/support/evidence-binding-gate.test.ts tests/support/transaction-evidence-scenarios.test.ts tests/support/reply-pipeline.test.ts tests/support/human-takeover.test.ts tests/support/technical-escalation.test.ts tests/support/response-depth.test.ts tests/runtime/reply-generation-audit.test.ts
```

- [ ] **Step 3: Run full project gates from a clean Node >=22.16 environment**

```bash
pnpm test
pnpm typecheck
pnpm build
```

- [ ] **Step 4: Start the build against a temporary data directory**

Use `mktemp -d` for an isolated runtime directory and the repository's documented environment/entry point. Verify `/health`, database schema version unchanged, old `reply_generation_audits` rows remain readable, and the process listens only on loopback. Stop the temporary process and retain no credentials.

- [ ] **Step 5: Run focused read-only replay on a copied production SQLite database**

Copy the production SQLite file to a temporary directory using the established read-only deployment access, run only the selected Deva case IDs plus a small safe control sample with all Telegram output disabled, and inspect:

- the incident association is `conflicting` or `unconfirmed`;
- the AOHPay candidate order facts are outbound unsafe;
- no answer claims configuration success or caller parsing from that candidate;
- safe stable-ID controls still produce usable answers;
- no production DB row or Telegram message changes.

- [ ] **Step 6: Request independent code review and fix findings**

Review schema compatibility, graph/gate correctness, strict pipeline fallback paths, sensitivity boundaries and lifecycle semantics. Apply every valid finding with a failing regression test first, then rerun the focused and full gates.

### Task 8: Push, production deployment, health verification and rollback readiness

**Files:**
- No source changes expected
- Production target: existing `telegram-ai-support` branch and `/opt/telegram-codex-support/current`

- [ ] **Step 1: Record the exact release commit and pre-deploy production commit**

Fetch without force, verify the remote branch is an ancestor-compatible fast-forward, record both commit hashes, and verify the worktree is clean. Do not include the dirty main worktree changes.

- [ ] **Step 2: Push the exact verified commit**

```bash
git push origin HEAD:telegram-ai-support
```

No force push and no payment-project branch writes.

- [ ] **Step 3: Deploy through the established SSH target**

In `/opt/telegram-codex-support/current`, fast-forward to the exact pushed commit, use the server's configured Node/pnpm, then run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
sudo systemctl restart telegram-codex-support.service
```

Do not replace, migrate, delete or edit the production SQLite database.

- [ ] **Step 4: Verify production**

Require all of the following before declaring success:

- `systemctl is-active telegram-codex-support.service` returns `active`;
- `curl --fail http://127.0.0.1:3210/health` succeeds;
- socket inspection shows the app port bound only to loopback;
- recent journal logs contain no restart loop, schema parse loop, repeated model structure rejection, credential exposure or Telegram duplicate send;
- admin console shows the deployed commit and Telegram/code-sync workers healthy;
- a non-sending synthetic or admin-side dry-run of the Deva mismatch produces no unsafe candidate claim.

- [ ] **Step 5: Roll back on any failed production gate**

If install, tests, build, restart or health checks fail, fast-forward/reset only the deployment checkout to the recorded pre-deploy support-project commit using the established deployment procedure, rebuild/restart it, and rerun all health checks. Never modify the user's main workspace or production data as part of rollback.

- [ ] **Step 6: Final handoff**

Report the release commit, files/behavior changed, focused and full test results, replay outcome, production health evidence, and whether rollback was needed. Also confirm the user's original dirty main-worktree changes remain untouched.
