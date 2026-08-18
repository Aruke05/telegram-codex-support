import { operatorStyleProfileSchema, type OperatorStyleProfile } from "./operator-style.js"
import { isIP } from "node:net"

type TextSpan = { start: number; end: number; value: string }

const structuredPatterns = [
  /```[\s\S]*?```|`[^`\r\n]+`/gu,
  /https?:\/\/[^\s，。！？；<>"']*[A-Za-z0-9/#?=&_%~!-]/giu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /\b[A-Za-z]:\\[^\s，。！？；<>"']+/gu,
  /\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*[A-Za-z0-9_~%/?=&-]/gu,
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/\d{1,2})?\b/gu,
  /\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b/giu,
  /\b[0-9A-F]{8}-[0-9A-F]{4}-[1-5][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\b/giu,
  /\b[A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z0-9_$-]+)+(?::\d{1,5})?\b/gu,
  /(?<!\d)[-+]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?%|\d+\.\d+)(?!\d)/gu,
  /(?<!\d)[-+]?\d+(?:\.\d+)?(?:ms|s|KB|MB|GB|TB)(?![A-Za-z0-9_])/giu,
  /\b[A-Za-z][A-Za-z0-9.+-]*\/[A-Za-z0-9.+-]+(?:;\s*[A-Za-z0-9_-]+=[A-Za-z0-9._-]+)*/gu,
  /\bv\d+(?:\.\d+)+\b/giu,
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?\b/gu,
  /\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b/gu,
  /\b[A-Za-z_$][A-Za-z0-9_$-]*(?:[:=][A-Za-z0-9_$%+./?=&-]+)+\b/gu,
] as const

function formalCopies(profile: OperatorStyleProfile): Array<[RegExp, string]> {
  return [
    ...(profile.allowedPhrases.includes("找对方看下") ? [[/建议联系/gu, "找"] as [RegExp, string]] : []),
    ...profile.forbiddenPhrases.map((phrase): [RegExp, string] => {
    const replacement = phrase === "即可"
      ? profile.allowedPhrases.includes("就行") ? "就行" : ""
      : phrase === "该问题"
        ? profile.allowedPhrases.includes("这个") ? "这个问题" : "问题"
        : phrase === "请提供" ? profile.clarification.requestMaterial : ""
    return [new RegExp(phrase, "gu"), replacement]
  }),
    [/(?:请提供|发下)/gu, profile.clarification.requestMaterial],
  ]
}

const mechanicalOpeningPattern = /^\s*(?:(?:这个|这种情况|这段时间|这笔订单|这笔|当前|目前|该功能|该订单)\s*)?(?:能查到|可以查到|已查到|查到了|已经查到|能查|可以查|能确认|可以确认|确认到了|是的|对|没错|确实|可以|能)[ \t]*(?:[，,。！？!；;：:]+[ \t]*|\r?\n+[ \t]*|[ \t]+|(?=\S)|$)/u

function jsonSpans(value: string): TextSpan[] {
  const spans: TextSpan[] = []
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "{" && value[start] !== "[") continue
    const stack: string[] = []
    let quoted = false
    let escaped = false
    for (let index = start; index < value.length; index += 1) {
      const character = value[index]!
      if (quoted) {
        if (escaped) escaped = false
        else if (character === "\\") escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"') {
        quoted = true
        continue
      }
      if (character === "{" || character === "[") stack.push(character)
      else if (character === "}" || character === "]") {
        const opening = stack.pop()
        if ((opening === "{" && character !== "}") || (opening === "[" && character !== "]")) break
        if (stack.length !== 0) continue
        const candidate = value.slice(start, index + 1)
        try {
          JSON.parse(candidate)
          spans.push({ start, end: index + 1, value: candidate })
          start = index
        } catch { /* 非完整 JSON 继续按普通文本处理。 */ }
        break
      }
    }
  }
  return spans
}

function ipLiteral(value: string): boolean {
  const bracketed = value.match(/^\[([^\]]+)\](?::\d{1,5})?(?:\/\d{1,3})?$/u)
  if (bracketed?.[1]) return isIP(bracketed[1]) === 6
  const withoutCidr = value.replace(/\/\d{1,3}$/u, "")
  if (isIP(withoutCidr) !== 0) return true
  const ipv4Port = withoutCidr.match(/^(.+):(\d{1,5})$/u)
  return Boolean(ipv4Port?.[1] && isIP(ipv4Port[1]) === 4)
}

function tokenSpan(value: string, start: number): TextSpan | null {
  const variants = [value]
  const unwrapped = value
    .replace(/^[（('"“‘]+/u, "")
    .replace(/[）)'"”’。，！？；,!?;]+$/u, "")
  if (unwrapped !== value) variants.push(unwrapped)
  const assigned = unwrapped.split(/[：=]/u).at(-1)
  if (assigned && assigned !== unwrapped) variants.push(assigned)
  for (const candidate of variants) {
    if (!ipLiteral(candidate)) continue
    const offset = value.lastIndexOf(candidate)
    return { start: start + offset, end: start + offset + candidate.length, value: candidate }
  }
  return null
}

function structuredSpans(value: string): TextSpan[] {
  const spans = jsonSpans(value)
  for (const pattern of structuredPatterns) {
    pattern.lastIndex = 0
    for (const matched of value.matchAll(pattern)) {
      const token = matched[0]
      const start = matched.index
      if (start === undefined || !token) continue
      if (/^https?:\/\//iu.test(token)) {
        try { new URL(token) } catch { continue }
      }
      if (/^(?:\d{1,3}\.){3}\d{1,3}/u.test(token) && !ipLiteral(token)) continue
      spans.push({ start, end: start + token.length, value: token })
    }
  }
  for (const matched of value.matchAll(/\S+/gu)) {
    if (matched.index === undefined) continue
    const span = tokenSpan(matched[0], matched.index)
    if (span) spans.push(span)
  }
  spans.sort((left, right) => left.start - right.start || right.end - left.end)
  const merged: TextSpan[] = []
  for (const span of spans) {
    const previous = merged.at(-1)
    if (!previous || span.start >= previous.end) {
      merged.push({ ...span })
      continue
    }
    if (span.end > previous.end) {
      previous.end = span.end
      previous.value = value.slice(previous.start, previous.end)
    }
  }
  return merged
}

function protectStructuredContent(value: string): {
  text: string
  values: string[]
  restore: (text: string) => string
} {
  const spans = structuredSpans(value)
  let markerIndex = 0
  let marker = `\uE000STRUCT${markerIndex}_`
  while (value.includes(marker)) {
    markerIndex += 1
    marker = `\uE000STRUCT${markerIndex}_`
  }
  const values = spans.map((span) => span.value)
  let cursor = 0
  const chunks: string[] = []
  spans.forEach((span, index) => {
    chunks.push(value.slice(cursor, span.start), `${marker}${index}\uE001`)
    cursor = span.end
  })
  chunks.push(value.slice(cursor))
  return {
    text: chunks.join(""),
    values,
    restore: (candidate) => candidate.replace(new RegExp(`${marker}(\\d+)\\uE001`, "gu"), (_matched, index: string) => (
      values[Number(index)] ?? ""
    )),
  }
}

function sameStructuredValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function formatOperatorText(value: string, profile: OperatorStyleProfile): string {
  const protectedValue = protectStructuredContent(value.trim())
  let text = protectedValue.text
  formalCopies(profile).forEach(([pattern, replacement]) => {
    text = text.replace(pattern, replacement)
  })
  const lines = text.split(/\r?\n/gu)
    .map((line) => line.replace(/[\t ]+/gu, " ").trim().replace(/^[，。！？；：,.!?;:]+/gu, ""))
    .filter(Boolean)
  const limitedLines = lines.length <= profile.simpleReply.maxLines
    ? lines
    : profile.simpleReply.maxLines === 1
      ? [lines.join(" ")]
      : [lines[0]!, lines.slice(1).join(" ")]
  return protectedValue.restore(limitedLines.join("\n")).trim()
}

export function stripMechanicalOperatorOpening(value: string): string {
  const stripped = value.replace(mechanicalOpeningPattern, "").trim()
  return stripped || value.trim()
}

export function humanizeOperatorAnswer(
  value: string,
  _latestMessage: string,
  profile: unknown,
): string {
  const parsedProfile = operatorStyleProfileSchema.parse(profile)
  const naturalValue = stripMechanicalOperatorOpening(value)
  const originalValues = structuredSpans(naturalValue).map((span) => span.value)
  const formatted = formatOperatorText(naturalValue, parsedProfile)
  const formattedValues = structuredSpans(formatted).map((span) => span.value)
  return sameStructuredValues(originalValues, formattedValues)
    ? formatted
    : naturalValue
}
