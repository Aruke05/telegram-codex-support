export type SensitiveCategory =
  | "private-key"
  | "connection-string"
  | "absolute-url"
  | "credential"
  | "business-identifier"
  | "email"
  | "ip-address"
  | "bank-card"

export type RedactionResult = {
  text: string
  changed: boolean
  categories: SensitiveCategory[]
}

export type SafeOutboundResult = {
  allowed: boolean
  categories: SensitiveCategory[]
  safeText: string
}

type SecretSource = {
  readServerResources(where?: string, parameters?: Array<string | number | null>): Array<{
    host: string
    username: string
    privateKey: string
    workdir?: string
  }>
  readDatabaseResources(where?: string, parameters?: Array<string | number | null>): Array<{
    host: string
    database: string
    username: string
    password: string
  }>
}

const replacement = "[已脱敏]"
const credentialFieldNames = "password|passwd|pwd|secret|token|api[_-]?key|api[_-]?hash|auth[_-]?key|string[_-]?session|session|md5?key|mdkey|sign|signature"
const businessIdentifierFieldNames = "merchantId|merchant_id|mchId|mch_id|mchNo|mch_no|merchantCode|merchant_code|merchantNo|merchant_no|merchNo|shbh|商户号|商戶號|商户编号|商戶編號|bankAccount|bank_account|payCardNo|pay_card_no|cardNo|card_no|cardNumber|card_number|payName|pay_name|payeeName|payee_name|customerName|customer_name|accountName|account_name|phone|mobile|email|notifyUrl|notify_url|callbackUrl|callback_url|upi|utr"
const sensitiveDlpFieldNamePattern = new RegExp(`^(?:${credentialFieldNames}|${businessIdentifierFieldNames})$`, "iu")

export function isSensitiveDlpFieldName(value: string): boolean {
  return sensitiveDlpFieldNamePattern.test(value)
}

function luhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, "")
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false

  let sum = 0
  let doubleDigit = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index])
    if (doubleDigit) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    doubleDigit = !doubleDigit
  }
  return sum % 10 === 0
}

export function redactText(input: string): RedactionResult {
  return redactTextWithUrlPolicy(input, false, false)
}

export function redactInboundText(input: string): RedactionResult {
  return redactTextWithUrlPolicy(input, true, false)
}

function redactBusinessOutboundText(input: string): RedactionResult {
  return redactTextWithUrlPolicy(input, true, true)
}

function redactTextWithUrlPolicy(
  input: string,
  preserveUrlStructure: boolean,
  preserveIpAddresses: boolean,
): RedactionResult {
  let text = input
  const categories = new Set<SensitiveCategory>()
  const redact = (pattern: RegExp, category: SensitiveCategory, replacer: string | ((substring: string, ...args: string[]) => string) = replacement) => {
    const next = text.replace(pattern, replacer as string)
    if (next !== text) categories.add(category)
    text = next
  }
  const redactFields = (fields: string, category: SensitiveCategory) => {
    const prefix = `(?<![\\p{L}\\p{N}_])(["']?)(?:${fields})\\1\\s*[:=：]\\s*`
    redact(new RegExp(`${prefix}"[^"]*"`, "giu"), category, (match) => `${match.slice(0, match.search(/[:=：]/u))}=${replacement}`)
    redact(new RegExp(`${prefix}'[^']*'`, "giu"), category, (match) => `${match.slice(0, match.search(/[:=：]/u))}=${replacement}`)
    redact(new RegExp(`${prefix}[^\\r\\n,;}&]+`, "giu"), category, (match) => `${match.slice(0, match.search(/[:=：]/u))}=${replacement}`)
  }

  redact(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
    "private-key",
  )
  redact(/-----BEGIN [A-Z ]*PRIVATE KEY-----|-----END [A-Z ]*PRIVATE KEY-----/gi, "private-key")
  redact(/(?:mysql|postgres(?:ql)?|redis):\/\/[^\s"'<>]+/gi, "connection-string")
  if (preserveUrlStructure) {
    redact(/https?:\/\/[^\s"'<>，,。；;）)\]}]+/gi, "absolute-url", (candidate) => {
      try {
        const url = new URL(candidate)
        const hadSensitiveParts = Boolean(url.username || url.password || url.search || url.hash)
        url.username = ""
        url.password = ""
        url.search = ""
        url.hash = ""
        return hadSensitiveParts ? url.toString() : candidate
      } catch {
        return replacement
      }
    })
  } else {
    redact(/https?:\/\/[^\s"'<>]+/gi, "absolute-url")
  }
  redact(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "credential")
  redactFields(credentialFieldNames, "credential")
  redact(/\b[a-f0-9]{32}\b/gi, "credential")
  redact(/\b[A-Za-z0-9+/_=-]{80,}\b/g, "credential")
  redactFields(businessIdentifierFieldNames, "business-identifier")
  redact(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "email")
  if (!preserveIpAddresses) redact(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "ip-address")

  const cardPattern = /\b(?:\d[ -]?){12,18}\d\b/g
  const cardRedacted = text.replace(cardPattern, (candidate) => luhnValid(candidate) ? replacement : candidate)
  if (cardRedacted !== text) categories.add("bank-card")
  text = cardRedacted

  return { text, changed: text !== input, categories: [...categories] }
}

export function assertSafeOutbound(input: string): SafeOutboundResult {
  const result = redactText(input)
  return {
    allowed: !result.changed,
    categories: result.categories,
    safeText: result.text,
  }
}

export class ConfiguredSecretRedactor {
  private secrets: string[] = []
  private privateKeyBodies: string[] = []

  constructor(
    private readonly source: SecretSource,
    private readonly additionalSecrets: () => string[] = () => [],
  ) {
    this.refresh()
  }

  refresh(): void {
    const servers = this.source.readServerResources()
    const databases = this.source.readDatabaseResources()
    this.privateKeyBodies = servers.map((server) => server.privateKey
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----|-----END [A-Z ]*PRIVATE KEY-----/gi, "")
      .replace(/\s+/g, ""))
      .filter((value) => value.length >= 16)
    this.secrets = [...new Set([
      ...servers.flatMap((server) => [server.host, server.username, server.privateKey, server.workdir ?? ""]),
      ...databases.flatMap((database) => [database.host, database.database, database.username, database.password]),
      ...this.additionalSecrets(),
    ].filter((value) => value.length >= 4))].sort((left, right) => right.length - left.length)
  }

  private redactConfigured(input: string, mode: "internal" | "inbound" | "business-outbound"): RedactionResult {
    this.refresh()
    let text = input
    let exactChanged = false
    this.secrets.forEach((secret) => {
      if (!text.includes(secret)) return
      text = text.split(secret).join(replacement)
      exactChanged = true
    })
    text = text.replace(/[A-Za-z0-9+/_=-]{16,}/g, (candidate) => {
      if (!this.privateKeyBodies.some((body) => body.includes(candidate))) return candidate
      exactChanged = true
      return replacement
    })
    const generic = mode === "inbound"
      ? redactInboundText(text)
      : mode === "business-outbound" ? redactBusinessOutboundText(text) : redactText(text)
    return {
      text: generic.text,
      changed: exactChanged || generic.changed,
      categories: exactChanged ? [...new Set<SensitiveCategory>(["credential", ...generic.categories])] : generic.categories,
    }
  }

  redact(input: string): RedactionResult {
    return this.redactConfigured(input, "internal")
  }

  redactInbound(input: string): RedactionResult {
    return this.redactConfigured(input, "inbound")
  }

  assertSafeOutbound(input: string): SafeOutboundResult {
    const result = this.redactConfigured(input, "business-outbound")
    return { allowed: !result.changed, categories: result.categories, safeText: result.text }
  }
}
