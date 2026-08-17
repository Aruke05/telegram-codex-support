# Human Directive Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add confirmed permanent deletion for human directives, keep system directives immutable and preserve append-only deletion audit evidence.

**Architecture:** `RuntimeKnowledgeService` owns the transactional delete invariant: validate the directive, append a `retraction` event, delete exactly one human directive, and bump `memory_generation`. A Fastify DELETE route exposes that operation, while the admin UI adds a confirmation dialog and calls the route through the typed API client.

**Tech Stack:** TypeScript 5.9, Node.js `node:sqlite`, Fastify 5, Vitest 3, browser-native DOM UI, pnpm 10.

## Global Constraints

- Only `source = 'human'` directives may be deleted.
- `source = 'system'` directives remain protected by both service validation and the existing SQLite trigger.
- Deletion removes the `directives` row permanently; there is no `deleted_at`, recycle bin, restore, or bulk-delete feature.
- Existing `memory_events` are never changed or deleted; each successful deletion adds a `retraction` event.
- The HTTP operation targets an exact directive ID and succeeds with `204 No Content`.
- The UI requires a second confirmation that displays the exact directive title and states that deletion cannot be undone.
- After release, delete the exact TataPay and NupaPay temporary directive titles and verify both are absent while their audit events remain.

---

## File Map

- Modify `src/runtime/knowledge-service.ts`: implement the transactional domain operation.
- Modify `src/routes/operations.ts`: expose `DELETE /api/directives/:id`.
- Modify `src/app.ts`: allow the new safe Chinese validation message to reach the admin UI.
- Create `tests/routes/directive-delete-api.test.ts`: cover service effects and API behavior against a real temporary SQLite database.
- Modify `web/src/api.ts`: add the DELETE client call.
- Modify `web/src/directive-presentation.ts`: keep delete confirmation copy in a pure, testable helper.
- Modify `web/src/views/memories.ts`: render the delete action and confirmation dialog for human rules only.
- Modify `tests/app.test.ts`: cover the frontend API request and confirmation copy without adding a DOM test dependency.

### Task 1: Transactional Human Directive Delete API

**Files:**
- Create: `tests/routes/directive-delete-api.test.ts`
- Modify: `src/runtime/knowledge-service.ts`
- Modify: `src/routes/operations.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: existing `RuntimeDatabase.transaction`, `RuntimeDatabase.readDirectives`, `RuntimeDatabase.insertEvent`, `RuntimeDatabase.bumpMemoryGeneration`, and `eventFor`.
- Produces: `RuntimeKnowledgeService.deleteDirective(id: string, actor: string): Promise<void>` and `DELETE /api/directives/:id` with JSON `{ actor: string }`.

- [ ] **Step 1: Write the failing API and persistence tests**

Create `tests/routes/directive-delete-api.test.ts` with a temporary SQLite harness and these three cases:

```ts
import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { buildApp } from "../../src/app.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { RuntimeKnowledgeService } from "../../src/runtime/knowledge-service.js"

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), "directive-delete-"))
  cleanup.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
  const knowledge = new RuntimeKnowledgeService(database)
  knowledge.ensureSystemDirectives()
  const app = buildApp({ runtimeKnowledgeService: knowledge, backupService: {} as never })
  await app.ready()
  return { app, database, knowledge }
}

describe("人工固定规则删除 API", () => {
  it("永久删除人工规则并保留撤回审计", async () => {
    const { app, database, knowledge } = await harness()
    try {
      const directive = await knowledge.createDirective({
        title: "临时规则", content: "临时处理内容", scope: "tatapay",
        source: "human", priority: 80, actor: "创建人",
      })
      const generation = database.memoryGeneration()

      const response = await app.inject({
        method: "DELETE", url: `/api/directives/${directive.id}`,
        payload: { actor: "后台管理员" },
      })

      expect(response.statusCode).toBe(204)
      expect(response.body).toBe("")
      expect(knowledge.listDirectives().some((item) => item.id === directive.id)).toBe(false)
      expect(database.memoryGeneration()).toBe(generation + 1)
      expect(knowledge.listEvents({ type: "retraction" })[0]).toMatchObject({
        content: "删除固定规则：临时规则", scope: "tatapay", actor: "后台管理员",
      })
    } finally {
      await app.close()
      database.close()
    }
  })

  it("拒绝删除系统固定规则", async () => {
    const { app, database, knowledge } = await harness()
    try {
      const system = knowledge.listDirectives().find((item) => item.source === "system")!
      const response = await app.inject({
        method: "DELETE", url: `/api/directives/${system.id}`,
        payload: { actor: "后台管理员" },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: "系统固定规则不能删除" })
      expect(knowledge.listDirectives().some((item) => item.id === system.id)).toBe(true)
    } finally {
      await app.close()
      database.close()
    }
  })

  it("不存在的规则返回安全中文错误", async () => {
    const { app, database } = await harness()
    try {
      const response = await app.inject({
        method: "DELETE", url: "/api/directives/00000000-0000-4000-8000-000000000099",
        payload: { actor: "后台管理员" },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: "固定规则不存在" })
    } finally {
      await app.close()
      database.close()
    }
  })
})
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```bash
pnpm test -- tests/routes/directive-delete-api.test.ts
```

Expected: FAIL because the DELETE route does not exist and returns 404.

- [ ] **Step 3: Implement the service transaction**

Add this method beside `setDirectiveEnabled` in `RuntimeKnowledgeService`:

```ts
async deleteDirective(id: string, actor: string): Promise<void> {
  const found = this.database.readDirectives("WHERE id=?", [id])[0]
  if (!found) throw new Error("固定规则不存在")
  if (found.source === "system") throw new Error("系统固定规则不能删除")
  const now = new Date().toISOString()
  this.database.transaction(() => {
    this.database.insertEvent(eventFor({
      type: "retraction", content: `删除固定规则：${found.title}`, factId: null,
      scope: found.scope, region: null, branch: null, risk: "high", confidence: 1,
      actor: this.sanitize(actor) || "后台管理员", occurredAt: now,
    }))
    const result = this.database.prepare("DELETE FROM directives WHERE id=? AND source='human'").run(id)
    if (result.changes !== 1) throw new Error("固定规则不存在")
    this.database.bumpMemoryGeneration()
  })
}
```

Do not set `allow_maintenance_delete`; the existing trigger permits deleting human directives and continues to reject system directives.

- [ ] **Step 4: Add the DELETE route and safe error message**

Add this route after the directive content PATCH route in `src/routes/operations.ts`:

```ts
app.delete<{ Params: { id: string }; Body: { actor?: string } }>("/api/directives/:id", async (request, reply) => {
  if (!request.body?.actor) throw new Error("固定规则删除格式错误")
  await knowledge.deleteDirective(request.params.id, request.body.actor)
  return reply.code(204).send()
})
```

Add both messages to the `safeMessages` array in `src/app.ts`:

```ts
"固定规则删除格式错误", "系统固定规则不能删除",
```

- [ ] **Step 5: Run the focused test and verify the green state**

Run:

```bash
pnpm test -- tests/routes/directive-delete-api.test.ts
```

Expected: 3 tests pass, 0 fail.

- [ ] **Step 6: Run server type checking**

Run:

```bash
pnpm exec tsc -p tsconfig.json --noEmit
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 7: Commit the backend slice**

```bash
git add src/runtime/knowledge-service.ts src/routes/operations.ts src/app.ts tests/routes/directive-delete-api.test.ts
git commit -m "功能：支持永久删除人工规则"
```

### Task 2: Confirmed Delete Action in the Admin UI

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/directive-presentation.ts`
- Modify: `web/src/views/memories.ts`
- Modify: `tests/app.test.ts`

**Interfaces:**
- Consumes: `DELETE /api/directives/:id` from Task 1 and existing `openDialog`, `actionButton`, `setButtonBusy` helpers.
- Produces: `ApiClient.deleteDirective(id: string): Promise<void>` and `directiveDeleteConfirmation(title: string): { title: string; warning: string }`.

- [ ] **Step 1: Write failing client and presentation tests**

Add these imports to `tests/app.test.ts`:

```ts
import { createApiClient } from "../web/src/api.js"
import { directiveDeleteConfirmation } from "../web/src/directive-presentation.js"
```

Add focused cases:

```ts
it("人工规则删除请求使用精确 ID 和后台操作者", async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
  const client = createApiClient(fetcher as typeof fetch)
  await client.deleteDirective("rule/id")
  expect(fetcher).toHaveBeenCalledWith("/api/directives/rule%2Fid", expect.objectContaining({
    method: "DELETE",
    body: JSON.stringify({ actor: "后台管理员" }),
  }))
})

it("人工规则删除确认文案包含精确标题和不可恢复提示", () => {
  expect(directiveDeleteConfirmation("TataPay 本次代理返佣异常临时处理")).toEqual({
    title: "删除 TataPay 本次代理返佣异常临时处理",
    warning: "删除后不能恢复，已有历史证据和删除审计仍会保留。",
  })
})
```

Ensure `vi` is included in the existing Vitest import.

- [ ] **Step 2: Run the focused frontend contract tests and verify the red state**

Run:

```bash
pnpm test -- tests/app.test.ts
```

Expected: FAIL because `deleteDirective` and `directiveDeleteConfirmation` do not exist.

- [ ] **Step 3: Implement the API client and pure confirmation copy**

Add to the directive section of `createApiClient` in `web/src/api.ts`:

```ts
deleteDirective: (id: string) => requestVoid(
  fetcher,
  `/api/directives/${encodeURIComponent(id)}`,
  json("DELETE", { actor: "后台管理员" }),
),
```

Add to `web/src/directive-presentation.ts`:

```ts
export function directiveDeleteConfirmation(title: string): { title: string; warning: string } {
  return {
    title: `删除 ${title}`,
    warning: "删除后不能恢复，已有历史证据和删除审计仍会保留。",
  }
}
```

- [ ] **Step 4: Add the confirmation dialog and delete button**

Import `directiveDeleteConfirmation` in `web/src/views/memories.ts`, then add this helper before `directiveRow`:

```ts
function deleteDirectiveDialog(directive: Directive, notify: Notify, refresh: () => Promise<void>): void {
  const copy = directiveDeleteConfirmation(directive.title)
  const warning = element("div", "inline-alert inline-alert--danger", copy.warning)
  const error = element("p", "form-error")
  const content = element("div", "dialog-form")
  content.append(warning, error)
  const cancel = actionButton("取消")
  const confirm = actionButton("确认删除", "danger")
  const modal = openDialog({ eyebrow: "删除确认", title: copy.title, content, actions: [cancel, confirm] })
  cancel.addEventListener("click", modal.close)
  confirm.addEventListener("click", () => {
    error.textContent = ""
    setButtonBusy(confirm, true)
    void api.deleteDirective(directive.id).then(async () => {
      notify("规则已删除")
      modal.close()
      await refresh()
    }).catch((cause: unknown) => {
      error.textContent = cause instanceof Error ? cause.message : "删除失败，请重试"
    }).finally(() => setButtonBusy(confirm, false))
  })
}
```

In the human-directive branch of `directiveRow`, create and append the third action:

```ts
const remove = actionButton("删除规则", "danger")
remove.addEventListener("click", () => deleteDirectiveDialog(directive, notify, refresh))
actions.append(edit, toggle, remove)
```

Do not add the button inside the `directive.source === "system"` branch.

- [ ] **Step 5: Run frontend tests and type checking**

Run:

```bash
pnpm test -- tests/app.test.ts
pnpm exec tsc -p tsconfig.web.json --noEmit
```

Expected: all `tests/app.test.ts` tests pass and web TypeScript exits 0.

- [ ] **Step 6: Build production assets and inspect the generated copy**

Run:

```bash
pnpm build:web
rg -n "删除规则|确认删除|规则已删除" dist/public/assets/views/memories.js
```

Expected: build exits 0 and all three strings are present in the generated view.

- [ ] **Step 7: Commit the UI slice**

```bash
git add web/src/api.ts web/src/directive-presentation.ts web/src/views/memories.ts tests/app.test.ts dist/public/assets
git commit -m "界面：增加人工规则删除确认"
```

### Task 3: Full Verification and Targeted Runtime Cleanup

**Files:**
- Verify only; no source file changes expected.

**Interfaces:**
- Consumes: completed backend DELETE API and admin UI from Tasks 1–2.
- Produces: verified build and removal of the two exact runtime directive records after the updated application is running against the intended SQLite data.

- [ ] **Step 1: Run the complete automated verification suite**

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: every command exits 0, Vitest reports 0 failed tests, and TypeScript/build report no errors.

- [ ] **Step 2: Verify the worktree contains only intended commits and generated assets**

```bash
git status --short --branch
git log -4 --oneline
```

Expected: no uncommitted changes; the design, plan, backend, and UI commits appear at the top of history.

- [ ] **Step 3: Open the updated admin console and verify the safety boundary**

Navigate to `AI 记忆库 → 固定规则` after the updated application is running. Confirm:

- A human rule shows `编辑规则`, its enable/disable action, and `删除规则`.
- A system rule shows `系统锁定` and no delete action.
- Clicking `删除规则` shows the exact title and the warning `删除后不能恢复，已有历史证据和删除审计仍会保留。`.
- Clicking `取消` closes the dialog without removing the rule.

- [ ] **Step 4: Permanently delete the two exact temporary directives**

Use the confirmation dialog once for each exact title:

```text
TataPay 本次代理返佣异常临时处理
NupaPay 本次代理返佣异常临时处理
```

Do not use a partial-title match and do not delete any other TataPay or NupaPay rule.

- [ ] **Step 5: Refresh and verify runtime state**

Refresh `AI 记忆库 → 固定规则` and verify both exact titles are absent. Query `GET /api/memory-events?type=retraction&limit=20` through the same updated application and verify one deletion audit event exists for each title with actor `后台管理员`.

- [ ] **Step 6: Record the final evidence**

Report:

```text
Automated tests: use the exact Vitest-reported passed-test count, 0 failed
Typecheck/build: passed
TataPay temporary directive: deleted
NupaPay temporary directive: deleted
Deletion audit events: 2 verified
```

If the updated application is not yet running against the intended SQLite database, stop before Step 4 and report that exact deployment/runtime dependency; do not create a new empty SQLite database and do not claim the rules were deleted.
