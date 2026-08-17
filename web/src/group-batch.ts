import type { BatchGroupPatch, ModelInstance, TelegramAccount, TelegramGroup } from "./types.js"

export type BatchGroupFormState = {
  groups: TelegramGroup[]
  accessMode: "" | TelegramGroup["accessMode"]
  accountId: string
  replyStyle: "" | TelegramGroup["replyStyle"]
}

export type BatchPatchResult =
  | { ok: true; patch: BatchGroupPatch }
  | { ok: false; error: string }

export function groupBatchActionBlocked(groupActionBusy: boolean, busyGroupCount: number): boolean {
  return groupActionBusy || busyGroupCount > 0
}

export async function performGroupQuickToggle(options: {
  group: TelegramGroup
  enabled: boolean
  update: (input: { ids: string[]; patch: { enabled: boolean } }) => Promise<{ groups: TelegramGroup[] }>
  onSuccess: (groups: TelegramGroup[]) => void
  onFailure: (cause: unknown) => void
  onSettled: () => void
}): Promise<void> {
  try {
    const response = await options.update({ ids: [options.group.id], patch: { enabled: options.enabled } })
    options.onSuccess(response.groups)
  } catch (cause) {
    options.onFailure(cause)
  } finally {
    options.onSettled()
  }
}

export function selectedGroups(groups: TelegramGroup[], selectedIds: ReadonlySet<string>): TelegramGroup[] {
  return groups.filter((group) => selectedIds.has(group.id))
}

export function allGroupsSelected(groups: TelegramGroup[], selectedIds: ReadonlySet<string>): boolean {
  return groups.length > 0 && groups.every((group) => selectedIds.has(group.id))
}

export function partitionGroupsForEnable(
  groups: TelegramGroup[],
  accounts: TelegramAccount[],
  _models: ModelInstance[] = [],
): {
  eligible: TelegramGroup[]
  skipped: TelegramGroup[]
} {
  return groups.reduce<{ eligible: TelegramGroup[]; skipped: TelegramGroup[] }>((result, group) => {
    const account = accounts.find((item) => item.id === group.accountId)
    const accountReady = Boolean(account?.enabled && account.type === group.accessMode)
    const purposeReady = group.purpose === "support"
      ? Boolean(group.projectId && group.serviceId)
      : true
    const ready = Boolean(group.telegramChatId && accountReady && purposeReady)
    result[ready ? "eligible" : "skipped"].push(group)
    return result
  }, { eligible: [], skipped: [] })
}

export function sharedAccessMode(groups: TelegramGroup[]): TelegramGroup["accessMode"] | null {
  const first = groups[0]?.accessMode
  return first && groups.every((group) => group.accessMode === first) ? first : null
}

export function accountOptions(
  accounts: TelegramAccount[],
  accessMode: TelegramGroup["accessMode"] | null,
): TelegramAccount[] {
  return accessMode ? accounts.filter((account) => account.type === accessMode) : []
}

export function buildBatchGroupPatch(
  form: BatchGroupFormState,
  accounts: TelegramAccount[],
): BatchPatchResult {
  if (form.groups.length === 0) return { ok: false, error: "请先选择白名单群" }
  const patch: BatchGroupPatch = {}
  if (form.accessMode) {
    if (!form.accountId) return { ok: false, error: "修改接入方式时必须选择匹配的客服账号" }
    patch.accessMode = form.accessMode
  }
  if (form.accountId) {
    const resolvedMode = form.accessMode || sharedAccessMode(form.groups)
    if (!resolvedMode) return { ok: false, error: "所选群接入方式不一致 请先统一接入方式" }
    const account = accounts.find((item) => item.id === form.accountId)
    if (!account) return { ok: false, error: "客服账号不存在" }
    if (account.type !== resolvedMode) return { ok: false, error: "客服账号与接入方式不一致" }
    patch.accountId = account.id
  }
  if (form.replyStyle) patch.replyStyle = form.replyStyle
  if (Object.keys(patch).length === 0) return { ok: false, error: "至少选择一项批量修改" }
  return { ok: true, patch }
}
