# Sender Conversation Focus Routing Implementation Plan

> **For Codex:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Apply superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before reporting success.

**Goal:** Eliminate Telegram support cross-thread replies by routing each sender through a deterministic group/service/sender focus, while preserving natural model-written clarification when two concrete topics are genuinely ambiguous.

**Architecture:** SQLite stores a rebuildable sender-focus projection and append-preserving route-clarification records. Explicit Telegram reply relationships and successful minimal clarifications remain deterministic. The route model is reduced to a bounded classifier: it may classify a message, choose one of a supplied pending clarification's candidates by index, or generate a natural clarification sentence for at most two supplied candidates; it can never emit a thread ID. The coordinator validates every state transition and updates focus only inside the same transaction that creates or appends the corresponding message relationship.

**Tech Stack:** TypeScript, Node.js 24 `node:sqlite`, Zod 4, Vitest 3, existing Codex structured-output executor.

---

## File map

- Modify `src/runtime/database.ts`: schema v24 tables, constraints, indexes, migration, topology assertions, open/openPortable version gates.
- Modify `src/runtime/types.ts`: strict schemas and types for sender focus and route clarification.
- Modify `src/codex/schemas.ts`: replace thread-ID-bearing route output with bounded route classification and clarification selection output.
- Modify `src/support/thread-router.ts`: pass only the sender's focus/pending candidates and request bounded classifications; prohibit generic lost-context wording.
- Modify `src/support/thread-store.ts`: transactional focus reads/writes, sender-owned candidate lookup, pending clarification lifecycle, and focus cleanup.
- Modify `src/support/thread-coordinator.ts`: deterministic routing priority, sender isolation, focus routing, pending clarification resolution, and natural clarification delivery.
- Modify `src/server.ts`: provide the coordinator's model-generated clarification sender through the existing unified Telegram output path.
- Modify `src/runtime/backup-service.ts`: include the v24 tables in portable SQLite export/import and validate their topology.
- Add `tests/runtime/sender-focus-schema.test.ts`: v24 fresh/migration/portable schema tests and database constraints.
- Add `tests/support/sender-focus-routing.test.ts`: deterministic routing, focus lifecycle, ambiguity, concurrency and regression tests.
- Add `tests/fixtures/chat-export-2026-08-14-routing-replay.json`: compact, anonymized incidents derived from the supplied export; no credentials or unrelated chat history.
- Update schema-version expectations in existing `tests/runtime/*.test.ts` and `tests/replies/retention-learning-observation.test.ts` from 23 to 24 where the current schema is asserted.

## Task 1: Lock the v24 data contract with failing tests

- [ ] Add fresh-schema and migration tests.
- [ ] Confirm they fail before implementation.
- [ ] Implement v24 schema and migration.
- [ ] Confirm focused schema tests pass.
- [ ] Commit the schema slice.

### Steps

1. Create `tests/runtime/sender-focus-schema.test.ts` with tests that open a fresh database and assert:
   - `schemaVersion()` is `24`.
   - `support_sender_focus` has a unique `(group_id, service_id, sender_user_id)` key, valid source constraint, thread/group/service foreign keys, and an expiry index.
   - `support_route_clarifications` accepts one or two candidate UUIDs and labels, allows only the four lifecycle states, permits only a selected thread contained in the candidate list at store level, and has one pending record per group/service/sender.
   - deleting a thread removes or invalidates its focus without deleting support message evidence.
2. Add a v23-to-v24 migration test by creating a current database, dropping the new tables, forcing metadata to `23`, reopening, and asserting both structures are restored with version `24`.
3. Add a portable SQLite open test for the same migration path.
4. Run only the new test with bundled Node 24 and record the expected failure:
   - `/Users/oldwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run tests/runtime/sender-focus-schema.test.ts`
5. In `src/runtime/database.ts`:
   - change the base schema version to `24`;
   - add both tables with strict `CHECK` constraints, foreign keys and indexes;
   - add `migrateV23ToV24()` inside `BEGIN IMMEDIATE`/`COMMIT`;
   - recognize the table/column/constraint capability so a divergent v23 lineage is upgraded rather than trusted by version alone;
   - invoke the migration from both `open()` and writable `openPortable()` and validate already-v24 databases.
6. Add strict Zod schemas/types in `src/runtime/types.ts`.
7. Update current-version assertions from `23` to `24`, retaining fixtures that intentionally simulate older versions.
8. Rerun the focused test and the existing runtime schema suites.
9. Commit: `git add src/runtime/database.ts src/runtime/types.ts tests/runtime tests/replies/retention-learning-observation.test.ts && git commit -m "数据库：新增发送人会话焦点与归属记录"`.

## Task 2: Build transactional focus and clarification store operations

- [ ] Write store tests for every focus transition and invalidation.
- [ ] Confirm the new tests fail.
- [ ] Implement store operations without coordinator changes.
- [ ] Run store and existing thread lifecycle tests.
- [ ] Commit the store slice.

### Steps

1. In `tests/support/sender-focus-routing.test.ts`, construct a minimal database/catalog/store harness and add tests for:
   - `createThreadForSender(...)` creates the thread and focus atomically with source `new_thread`.
   - `appendMessageForSender(...)` appends with revision CAS and moves focus atomically for `explicit_reply`, `operator_reply`, or `clarification_answer`.
   - focus lookup returns `null` for another sender, another service, a closed thread, or a focus older than 30 minutes.
   - an ignored/role event and a failed or progress-only reply do not change focus.
   - pending clarification creation cancels the prior pending row for the same sender while preserving that row for audit.
   - clarification resolution rejects an out-of-set selection and atomically appends the event, resolves the row and switches focus for an in-set selection.
2. Run the new support test and confirm missing APIs fail compilation/runtime.
3. In `src/support/thread-store.ts`, add typed operations:
   - `getSenderFocus(groupId, serviceId, senderUserId, reference?)`;
   - `createThreadWithSenderFocus(input, sender, source)`;
   - `appendMessageWithSenderFocus(input, sender, source)`;
   - `setSenderFocusAfterDeliveredReply(threadId, senderUserId, botMessageId, reference?)`;
   - `createRouteClarification(...)`, `getPendingRouteClarification(...)`, `resolveRouteClarification(...)`, and `cancelPendingRouteClarification(...)`.
4. Keep every focus write in the existing `RuntimeDatabase.transaction()` that creates/appends/resolves its support relationship. Use `(focused_at, updated_at)` conditional updates so an older operation cannot overwrite a newer focus.
5. Derive candidate labels from each candidate thread's latest valid operator message, normalized only by safe trimming and a bounded maximum; do not synthesize a fixed customer reply.
6. Make `archiveExpired()` cancel/expire pending clarifications and delete stale focus projections after threads are closed. Correct reads must still validate thread status and expiry before cleanup runs.
7. Run:
   - new sender-focus support tests;
   - `tests/support/human-takeover.test.ts`;
   - `tests/support/learning-source-observer.test.ts`.
8. Commit: `git add src/support/thread-store.ts tests/support/sender-focus-routing.test.ts && git commit -m "客服：持久化发送人会话焦点"`.

## Task 3: Remove arbitrary thread selection from the route model

- [ ] Add schema and router contract tests.
- [ ] Confirm thread-ID outputs are rejected.
- [ ] Replace route schemas and prompt inputs.
- [ ] Run classifier unit tests.
- [ ] Commit the classifier slice.

### Steps

1. Extend `tests/support/sender-focus-routing.test.ts` with structured-output tests asserting:
   - normal classification is exactly one of `follow_up`, `new_thread`, `idle`, `uncertain`;
   - pending clarification selection is `candidate_1`, `candidate_2`, `new_thread`, `idle`, or `uncertain`;
   - output containing `targetThreadId` fails strict Zod validation;
   - a clarification prompt is non-empty, short Chinese, includes both supplied candidate meanings, and is rejected if it contains `AI`, `机器人`, `模型`, `自动客服`, `程序`, `你问的是哪项`, `具体事项发一下`, or equivalent generic lost-context phrasing.
2. In `src/codex/schemas.ts`, remove `targetThreadId` from `ThreadRouteIntent`. Define a strict discriminated result carrying classification, normalized question fragment, reason, confidence, optional candidate selection, and optional model-written clarification reply.
3. In `src/support/thread-router.ts`, change `ThreadRouteInput` to accept:
   - at most one current focus with its concrete recent context;
   - zero or one pending clarification with one or two numbered candidates;
   - no unrestricted candidate thread list.
4. Rewrite the routing prompt so the model only classifies the latest sender's batch. Tell it that Telegram reply relationships have already been resolved and that candidate numbers are the only selectable references.
5. Validate clarification copy after Zod parsing with a dedicated pure function. Invalid copy causes an exception so the coordinator stays silent; never replace it with fixed text.
6. Run the focused tests plus TypeScript typecheck to expose every old call site.
7. Commit: `git add src/codex/schemas.ts src/support/thread-router.ts tests/support/sender-focus-routing.test.ts && git commit -m "客服：限制路由模型只做消息分类"`.

## Task 4: Enforce deterministic routing priority in the coordinator

- [ ] Add incident and priority regression tests.
- [ ] Confirm existing coordinator misroutes at least one replay case.
- [ ] Implement deterministic focus routing and ambiguity lifecycle.
- [ ] Run all coordinator/support tests.
- [ ] Commit the coordinator slice.

### Steps

1. Extend the coordinator harness in `tests/support/sender-focus-routing.test.ts` with a fake bounded classifier and a captured clarification sender.
2. Add priority tests for:
   - active `reply_to` always appends the referenced thread and switches only that sender's focus;
   - reply to an unthreaded recorded operator message creates a new thread with quoted context;
   - reply to closed/archived content creates a new thread rather than reopening it;
   - a unique successfully delivered `minimal_clarification` consumes the same sender's bare short answer without calling the classifier;
   - with a valid focus, `follow_up` can append only that focus, `new_thread` creates and focuses a new thread, and `idle` changes no focus;
   - no focus plus a complete support message creates a new thread; no model output may attach it to another sender's thread;
   - `uncertain` creates a pending clarification with at most two same-sender candidates and sends only the model-written clarification;
   - a later candidate selection resolves only within that persisted candidate set;
   - a later independent question cancels the pending clarification, creates a new thread, and switches focus;
   - classifier failure, invalid clarification copy, or send failure records internal failure/pending state and sends no fallback text.
3. In `src/support/thread-coordinator.ts`, replace `listRouteCandidates()` plus `targetThreadId` handling with this exact order:
   1. explicit active reply;
   2. unresolved/closed reply reference -> new thread with context;
   3. unique minimal clarification;
   4. pending route clarification resolution;
   5. valid sender focus classification;
   6. deterministic new thread when no legal focus exists and the message is support material;
   7. bounded ambiguity clarification only when the classifier returns `uncertain` with two legitimate same-sender candidates.
4. Use the transactional store wrappers for every create/append action. Keep existing revision CAS, stale-generation cancellation and latest-message reply targeting unchanged.
5. Add a `sendRouteClarification` dependency that takes model output, persists/uses an ownership-safe send operation, and records the returned Telegram message ID on the pending row. It must not reuse `sendHelp` because clarification is an ordinary model-authored support response.
6. Update `src/server.ts` to wire this dependency through the existing Telegram sender/output ownership path, replying to the latest event in the batch. On Telegram failure, record failure and do not emit fallback text.
7. Run:
   - `tests/support/sender-focus-routing.test.ts`;
   - `tests/support/raw-message-preservation.test.ts`;
   - `tests/support/human-takeover.test.ts`;
   - `tests/support/learning-source-observer.test.ts`;
   - `tests/telegram/runtime-learning-source.test.ts`.
8. Commit: `git add src/support/thread-coordinator.ts src/server.ts tests/support/sender-focus-routing.test.ts && git commit -m "客服：按发送人会话焦点阻断串线"`.

## Task 5: Preserve v24 data in portable SQLite migration

- [ ] Add backup round-trip tests.
- [ ] Confirm v24 focus data is currently lost.
- [ ] Update backup table ordering and copy columns.
- [ ] Run backup/import suites.
- [ ] Commit the migration slice.

### Steps

1. Extend `tests/runtime/sender-focus-schema.test.ts` to seed two threads, one focus and pending/resolved clarification records, export a portable migration SQLite, import it into a fresh runtime database, and compare every field.
2. Verify encrypted Telegram/account credentials remain excluded while the focus projection and clarification audit remain included.
3. In `src/runtime/backup-service.ts`, add both v24 tables to portable table validation, deletion/import order and explicit-column copy lists after their referenced parent tables.
4. Treat absent v24 tables as a v23 portable input that must be migrated, not as silently empty v24 data.
5. Run all backup and runtime schema tests.
6. Commit: `git add src/runtime/backup-service.ts tests/runtime/sender-focus-schema.test.ts && git commit -m "迁移：保留会话焦点与归属审计"`.

## Task 6: Add anonymized incident replay and hard human-voice gates

- [ ] Add the compact replay fixture.
- [ ] Make the old routing behavior fail the replay.
- [ ] Pass every deterministic and language hard gate.
- [ ] Commit the acceptance slice.

### Steps

1. Create `tests/fixtures/chat-export-2026-08-14-routing-replay.json` with anonymized event sequences for:
   - account-name follow-up equivalent to `kakaxi` after account creation;
   - another sender discussing PopPay between those messages;
   - PopPay follow-ups equivalent to “你不能查一下吗” and “人呢”;
   - “加急一下”, “这个好了没”, “这个呢”, and “1” after interleaved senders;
   - two equal same-sender candidates requiring concrete clarification.
2. Add a table-driven replay test that ingests each event through `SupportThreadCoordinator`, flushes the batch, and asserts exact thread ownership and focus after every step.
3. Add hard gates scanning all captured normal and clarification replies for automation identity terms and generic lost-context phrases. Add preservation assertions for a URL, order number, amount, percentage, date/time and error token.
4. Repeat the deterministic replay three times in the test to catch order-sensitive state leakage. Do not call live models in CI; live enabled-model three-run acceptance remains a deployment gate and must be executed only on the user-designated Linux deployment server.
5. Run the replay test three times in separate Vitest processes.
6. Commit: `git add tests/fixtures/chat-export-2026-08-14-routing-replay.json tests/support/sender-focus-routing.test.ts && git commit -m "测试：回放真实串线事故与真人口吻门禁"`.

## Task 7: Full verification and delivery review

- [ ] Run focused tests.
- [ ] Run full tests and typechecks under Node 24.
- [ ] Review the diff against the approved design.
- [ ] Record any unrelated pre-existing failures exactly.
- [ ] Commit final fixes if verification exposes regressions.

### Steps

1. Run focused verification:
   - `/Users/oldwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run tests/runtime/sender-focus-schema.test.ts tests/support/sender-focus-routing.test.ts`
2. Run full server/web typecheck:
   - `/Users/oldwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
   - `/Users/oldwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit`
3. Run the full Vitest suite:
   - `/Users/oldwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run`
4. Inspect `git diff HEAD~6 --check`, `git status --short`, and the final commit list.
5. Review these invariants directly in code:
   - no route output can carry a thread ID;
   - every implicit append is constrained to the same sender's valid focus or persisted candidate set;
   - no ordinary support fallback copy is generated in code;
   - failed model/send/progress paths never move focus;
   - 30-minute close/archive invalidates focus and pending clarification;
   - migration export/import preserves v24 data without credentials.
6. If full tests still show the known executor permission-flag helper failures, verify production capability detection separately and report them as pre-existing only if their failure signatures are unchanged. Do not change unrelated executor behavior in this task.
7. Do not start, install, restart, deploy or health-check the local resident service. Live-model three-run replay and rollout belong only on the user-designated Linux deployment server.
