export type DirectivePresentation = { status: string; toggleAction: string }

export function directivePresentation(enabled: boolean): DirectivePresentation {
  return enabled
    ? { status: "当前状态 · 已启用", toggleAction: "停用规则" }
    : { status: "当前状态 · 已停用", toggleAction: "启用规则" }
}

export function directiveDeleteConfirmation(title: string): { title: string; warning: string } {
  return {
    title: `删除 ${title}`,
    warning: "删除后不能恢复，已有历史证据和删除审计仍会保留。",
  }
}
