import type { MagicBookOption } from "./types.js"

export function filterOptions(options: MagicBookOption[], query: string): MagicBookOption[] {
  const keyword = query.trim().toLocaleLowerCase("zh-CN")
  if (!keyword) return options
  return options.filter((option) => [option.label, option.value]
    .some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword)))
}
