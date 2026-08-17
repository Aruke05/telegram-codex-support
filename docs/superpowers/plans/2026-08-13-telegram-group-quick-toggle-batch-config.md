# 白名单群快捷启停与批量配置实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为白名单群增加客服群单行即时开关，以及原子化的批量启停和接入配置能力，并部署到既有 Linux 服务。

**Architecture:** `RuntimeAdminService` 提供严格白名单、先校验后事务提交的统一批量更新方法，单群开关和批量接口复用它。前端使用纯函数维护选择和批量表单约束，列表组件只负责渲染、调用 API、处理忙碌与失败回滚。

**Tech Stack:** Node.js 22+、TypeScript、Fastify 5、SQLite、Zod 4、原生 DOM/CSS、Vitest 3、systemd。

## Global Constraints

- 批量可写字段仅为 `enabled`、`accessMode`、`accountId`、`replyStyle`。
- 项目归属、群用途、技术群模型、触发方式和群基础信息不得被批量接口修改。
- 客服群触发方式始终是 `all`，技术告警群始终是 `command`。
- 任一群校验失败时整批不得产生写入。
- 技术告警群不显示单行即时开关，但允许在明确多选后批量启停。
- 不修改 SQLite schema，不覆盖现有运行库。
- 前端保持轻量原生 TypeScript/CSS，并验证浅色、深色和窄屏。
- 只提交本功能文件，不纳入工作区已有的删除和未跟踪内容。

---

### Task 1: 原子批量更新服务与 API

**Files:**
- Create: `tests/routes/group-batch-api.test.ts`
- Modify: `src/runtime/admin-service.ts`
- Modify: `src/routes/runtime-admin.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Produces: `BatchGroupUpdateInput = { ids: string[]; patch: BatchGroupPatch }`
- Produces: `RuntimeAdminService.updateGroups(input): Promise<PublicRuntimeGroup[]>`
- Produces: `PATCH /api/telegram/groups` returning `{ groups: PublicRuntimeGroup[] }`

- [ ] **Step 1: Write the failing API tests**

Create a focused real-database harness with one enabled Bot account, one enabled personal account, two support groups and one technical alert group. Add tests that assert literal persisted values for:

```ts
const response = await app.inject({
  method: "PATCH",
  url: "/api/telegram/groups",
  payload: { ids: [supportA, supportB], patch: { enabled: true } },
})
expect(response.statusCode).toBe(200)
expect(database.prepare("SELECT enabled FROM telegram_groups WHERE id IN (?,?) ORDER BY id").all(supportA, supportB))
  .toEqual([{ enabled: 1 }, { enabled: 1 }])
```

Also cover batch disable; changing `accessMode`, `accountId`, and `replyStyle`; preservation of `project_id`, `service_id`, `purpose`, `ai_model_instance_id`, and `trigger_mode`; rollback when one group has an incompatible account; empty patch; duplicate IDs; missing group; and unknown patch fields.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run tests/routes/group-batch-api.test.ts`

Expected: FAIL because `PATCH /api/telegram/groups` is not registered.

- [ ] **Step 3: Add strict batch schemas and shared candidate validation**

In `src/runtime/admin-service.ts`, add:

```ts
const batchGroupPatchSchema = z.object({
  enabled: z.boolean().optional(),
  accessMode: groupInputFields.accessMode.optional(),
  accountId: z.string().uuid().optional(),
  replyStyle: groupInputFields.replyStyle.optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "至少选择一项批量修改")

const batchGroupUpdateSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "群 ID 不能重复"),
  patch: batchGroupPatchSchema,
}).strict()
```

Export the inferred input types. Extract the current full-merge and validation logic into private helpers so `updateGroup` and `updateGroups` use exactly the same account, project, model, purpose and sensitive-content checks.

- [ ] **Step 4: Implement transaction-only-after-validation**

`updateGroups` must parse input, resolve every ID, build and validate all candidates before calling `database.transaction`. Use one timestamp for the whole batch and update only `enabled`, `access_mode`, `account_id`, `reply_style`, and `updated_at` in the transaction. Prefix validation errors with the safe group name, for example `客服一群：群接入方式与账号类型不一致`.

- [ ] **Step 5: Register the route and safe error handling**

Register `PATCH /api/telegram/groups` before the `/:id` route and return `{ groups }`. Extend the Fastify safe-error handler only for deterministic batch errors that contain a redacted group name; never echo arbitrary exception text.

- [ ] **Step 6: Run focused and route regression tests**

Run: `pnpm vitest run tests/routes/group-batch-api.test.ts tests/routes/admin-api.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 7: Commit the backend unit**

```bash
git add src/runtime/admin-service.ts src/routes/runtime-admin.ts src/app.ts tests/routes/group-batch-api.test.ts
git commit -m "功能：增加白名单群批量更新接口"
```

---

### Task 2: 前端批量状态模型与 API 客户端

**Files:**
- Create: `web/src/group-batch.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `tests/app.test.ts`

**Interfaces:**
- Produces: `BatchGroupPatch` and `BatchGroupUpdateInput` frontend types matching the server.
- Produces: `selectedGroups(groups, ids)`, `sharedAccessMode(groups)`, `accountOptions(accounts, accessMode)`, and `buildBatchGroupPatch(form)` pure functions.
- Produces: `api.updateGroups(input)`.

- [ ] **Step 1: Write failing pure-function tests**

Add table-driven tests with hand-written expected values for selection order, all-selected detection, mixed access mode returning `null`, matching account filtering, empty form producing an error, reply-style-only patch, and coupled access-mode/account patches.

- [ ] **Step 2: Run the focused frontend test and verify RED**

Run: `pnpm vitest run tests/app.test.ts`

Expected: FAIL because `web/src/group-batch.ts` does not exist.

- [ ] **Step 3: Implement focused pure helpers and shared types**

Keep `web/src/group-batch.ts` free of DOM and network access. Represent “不修改” as an empty string in form state and return a discriminated result:

```ts
type BatchPatchResult =
  | { ok: true; patch: BatchGroupPatch }
  | { ok: false; error: string }
```

Reject access-mode changes without a matching account, account-only changes across mixed current modes, and empty patches.

- [ ] **Step 4: Add the API client**

Add `updateGroups(input)` using `PATCH /api/telegram/groups` and return `{ groups: TelegramGroup[] }`.

- [ ] **Step 5: Run tests and typecheck the helper boundary**

Run: `pnpm vitest run tests/app.test.ts && pnpm typecheck`

Expected: PASS with zero test or type errors.

- [ ] **Step 6: Commit the frontend model unit**

```bash
git add web/src/group-batch.ts web/src/types.ts web/src/api.ts tests/app.test.ts
git commit -m "功能：增加群批量配置状态模型"
```

---

### Task 3: 白名单群列表、批量弹窗与响应式样式

**Files:**
- Modify: `web/src/views/accounts-groups.ts`
- Modify: `web/styles.css`

**Interfaces:**
- Consumes: `api.updateGroups`, batch helper functions and batch types from Task 2.
- Produces: accessible group selection controls, support-group quick switch, batch toolbar and batch configuration dialog.

- [ ] **Step 1: Add list selection state and controls**

Maintain `selectedGroupIds: Set<string>` inside `renderConnections`. Add a native checkbox with a stable accessible label to every group row and a “全选当前群” checkbox above the group list. Clear IDs that disappear after refresh.

- [ ] **Step 2: Add the selected-count toolbar and atomic actions**

Render “已选 N 个群”“批量启用”“批量停用”“批量配置”“取消选择”. Batch enable/disable calls `api.updateGroups({ ids, patch: { enabled } })`, disables the toolbar while pending, retains selection on error, and refreshes from server on success.

- [ ] **Step 3: Add the support-group quick switch**

For `purpose === "support"`, render a native checkbox switch labeled `启用客服群 <群名>`. Update the visible state immediately, call the one-ID batch API, lock it while pending, and restore the prior state on failure. Do not render this control for technical alert groups.

- [ ] **Step 4: Add the batch configuration dialog**

Provide “不修改 / Bot / 个人账号” access mode, a matching account selector, “不修改 / 真人口吻 / AI 原始回复” reply style, and read-only trigger summaries for the selected purposes. Use `buildBatchGroupPatch` for validation and keep the dialog open with inline error text when invalid or rejected.

- [ ] **Step 5: Add restrained responsive styles**

Style `.group-selection`, `.group-batch-toolbar`, `.group-quick-toggle`, and `.batch-trigger-summary` using existing surface, border, accent, focus and button tokens. At `max-width: 760px`, allow toolbar/action wrapping and stack row content without horizontal overflow. Add disabled/busy opacity without removing focus visibility.

- [ ] **Step 6: Run static verification**

Run: `pnpm typecheck && pnpm build`

Expected: both commands exit 0.

- [ ] **Step 7: Commit the UI unit**

```bash
git add web/src/views/accounts-groups.ts web/styles.css
git commit -m "功能：增加白名单群快捷启停与批量操作"
```

---

### Task 4: 完整验证、视觉验收与部署

**Files:**
- Read: all changed files and deployment configuration outside Git.
- Modify remotely: existing checked-out application revision and systemd service process only.

**Interfaces:**
- Consumes: the complete feature from Tasks 1–3.
- Produces: verified local commit and a healthy Linux deployment at `127.0.0.1:3210`.

- [ ] **Step 1: Run full local verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check HEAD~3..HEAD
```

Expected: all tests pass, both TypeScript projects typecheck, production build exits 0, and no whitespace errors exist.

- [ ] **Step 2: Inspect the actual UI in four states**

Run the built application only in an isolated temporary data directory for visual QA, not as a local resident service. Use the in-app browser to inspect desktop light, desktop dark, narrow light and narrow dark. Verify selection, toolbar, quick switch, dialog scrolling, focus rings and absence of horizontal overflow; stop the temporary process afterward.

- [ ] **Step 3: Review the final diff and requirements**

Confirm the diff contains only the spec, plan, backend contract, focused tests, frontend helper/API, group view and styles. Check every design requirement against a test or visual observation.

- [ ] **Step 4: Push the exact feature revision**

Push the verified commit to the existing GitLab `telegram-ai-support` branch using a normal fast-forward push. Do not force-push.

- [ ] **Step 5: Deploy on the configured Linux server**

Resolve the target and authentication from the existing restricted local deployment configuration. Record the remote pre-deploy commit. Pull the exact pushed revision, install locked dependencies, run the production build, and restart the existing systemd unit. Do not replace or migrate the SQLite database.

- [ ] **Step 6: Verify production and roll back on failure**

On the server verify `systemctl is-active`, `curl --fail http://127.0.0.1:3210/health`, `ss` showing only `127.0.0.1:3210`, and recent journal entries without exposing secrets. If any gate fails, restore the recorded pre-deploy commit, rebuild, restart, and repeat health checks.

- [ ] **Step 7: Commit any verification-only correction and report**

If visual or deployment verification required code corrections, repeat the relevant RED/GREEN cycle and all local gates before another push. Report the deployed commit, test counts and health evidence without credential details.
