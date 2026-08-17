import type {
  MagicBookOption,
  SafeMagicBookKey,
  SafeMagicBookParameter,
  SafeMagicBookSnapshot,
} from "../magicbook/types.js"

type MissingServiceKnowledge = { found: false; service: string }
type MissingRegionKnowledge = { found: false; region: string }

export type RegionKnowledge = MissingRegionKnowledge | {
  found: true
  region: string
  transactionTypes: MagicBookOption[]
  bankCodes: MagicBookOption[]
  indiaIfscNotice: boolean
  sourceVersion: string
  contentHash: string
}

export type ServiceKnowledge = MissingServiceKnowledge | {
  found: true
  service: string
  region: string
  branch: string
  transactionTypes: MagicBookOption[]
  bankCodes: MagicBookOption[]
  indiaIfscNotice: boolean
  sourceVersion: string
  contentHash: string
}

function normalized(value: string): string {
  return value.trim().toLowerCase()
}

export class KnowledgeResolver {
  private readonly snapshot: SafeMagicBookSnapshot

  constructor(snapshot: SafeMagicBookSnapshot) {
    this.snapshot = structuredClone(snapshot)
  }

  private parameter(key: SafeMagicBookKey): SafeMagicBookParameter {
    const parameter = this.snapshot.parameters.find((candidate) => candidate.key === key)
    if (!parameter) throw new Error("MagicBook 知识关系不完整")
    return parameter
  }

  private mappedOptions(key: SafeMagicBookKey, sourceValue: string): MagicBookOption[] {
    const rule = this.parameter(key).mappingRules.find((candidate) => candidate.sourceValues
      .some((value) => normalized(value) === normalized(sourceValue)))
    return structuredClone(rule?.values ?? [])
  }

  lookupRegion(region: string): RegionKnowledge {
    const canonicalRegion = this.parameter("targetRegion").mappingRules
      .flatMap((rule) => rule.values)
      .find((option) => normalized(option.value) === normalized(region))?.value
    if (!canonicalRegion) return { found: false, region: region.trim() }

    return {
      found: true,
      region: canonicalRegion,
      transactionTypes: this.mappedOptions("transactionType", canonicalRegion),
      bankCodes: this.mappedOptions("bankCode", canonicalRegion),
      indiaIfscNotice: canonicalRegion === "印度",
      sourceVersion: this.snapshot.sourceVersion,
      contentHash: this.snapshot.contentHash,
    }
  }

  lookupService(service: string): ServiceKnowledge {
    const canonicalService = this.parameter("sourceService").options
      .find((option) => normalized(option.value) === normalized(service))?.value
    if (!canonicalService) return { found: false, service: service.trim() }

    const region = this.mappedOptions("targetRegion", canonicalService)[0]?.value
    const branch = this.mappedOptions("branch", canonicalService)[0]?.value
    if (!region || !branch) throw new Error("MagicBook 知识关系不完整")
    const regionKnowledge = this.lookupRegion(region)
    if (!regionKnowledge.found) throw new Error("MagicBook 知识关系不完整")

    return {
      found: true,
      service: canonicalService,
      region,
      branch,
      transactionTypes: regionKnowledge.transactionTypes,
      bankCodes: regionKnowledge.bankCodes,
      indiaIfscNotice: regionKnowledge.indiaIfscNotice,
      sourceVersion: this.snapshot.sourceVersion,
      contentHash: this.snapshot.contentHash,
    }
  }
}
