import type {
  AnswerDecision,
  EvidenceAssociation,
  EvidenceFact,
  EvidencePacket,
  ResponsibilityAssessment,
} from "../codex/schemas.js"
import {
  evidenceProvenanceCanSupportCurrentResponsibility,
  evidenceSourceMatchesProvenance,
} from "../codex/schemas.js"

export type EvidenceBindingIssue = {
  code: string
  message: string
  associationId?: string
  factId?: string
  claimIndex?: number
}

export type EvidenceBindingGateInput = {
  packet: EvidencePacket
  claims: AnswerDecision["answerClaims"]
  responsibility: ResponsibilityAssessment
}

export type EvidenceBindingGateResult = {
  packet: EvidencePacket
  issues: EvidenceBindingIssue[]
  strictReviewRequired: boolean
}

export class EvidenceBindingStructuralError extends Error {
  readonly issues: EvidenceBindingIssue[]

  constructor(issues: EvidenceBindingIssue[]) {
    super(issues.map((issue) => issue.message).join("；"))
    this.name = "EvidenceBindingStructuralError"
    this.issues = issues
  }
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    else seen.add(value)
  }
  return [...repeated]
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (new Set(left).size !== new Set(right).size) return false
  const rightSet = new Set(right)
  return [...new Set(left)].every((value) => rightSet.has(value))
}

function structuralIssue(
  code: string,
  message: string,
  details: Pick<EvidenceBindingIssue, "associationId" | "factId" | "claimIndex"> = {},
): EvidenceBindingIssue {
  return { code, message, ...details }
}

function validateStructure(input: EvidenceBindingGateInput): Map<string, EvidenceFact> {
  const issues: EvidenceBindingIssue[] = []
  const factIds = input.packet.facts.map((fact) => fact.id)
  const associationIds = input.packet.associations.map((association) => association.id)
  for (const factId of duplicates(factIds)) {
    issues.push(structuralIssue("duplicate_fact_id", `证据事实 ${factId} 重复`, { factId }))
  }
  for (const associationId of duplicates(associationIds)) {
    issues.push(structuralIssue("duplicate_association_id", `交易关联 ${associationId} 重复`, { associationId }))
  }

  const facts = new Map<string, EvidenceFact>()
  for (const fact of input.packet.facts) {
    if (!facts.has(fact.id)) facts.set(fact.id, fact)
  }
  const associations = new Map<string, EvidenceAssociation>()
  for (const association of input.packet.associations) {
    if (!associations.has(association.id)) associations.set(association.id, association)
  }

  for (const fact of input.packet.facts) {
    if (!evidenceSourceMatchesProvenance(fact.provenance, fact.evidenceSource)) {
      issues.push(structuralIssue(
        "provenance_evidence_source_mismatch",
        `证据事实 ${fact.id} 的 provenance=${fact.provenance} 与 evidenceSource=${fact.evidenceSource} 不匹配`,
        { factId: fact.id },
      ))
    }
    if (fact.provenance === "user_report" && fact.certainty !== "reported") {
      issues.push(structuralIssue(
        "user_report_certainty_invalid",
        `聊天转述证据事实 ${fact.id} 只能标为 reported`,
        { factId: fact.id },
      ))
    }
    if (fact.subjectKind !== "transaction" && fact.identifiers.length > 0) {
      issues.push(structuralIssue(
        "non_transaction_stable_identifier",
        `非交易证据事实 ${fact.id} 不能携带交易稳定标识`,
        { factId: fact.id },
      ))
    }
    if (fact.subjectKind !== "transaction" && fact.associationId !== null) {
      issues.push(structuralIssue(
        "non_transaction_association",
        `非交易证据事实 ${fact.id} 不能加入交易关联`,
        { factId: fact.id, associationId: fact.associationId },
      ))
    }
    if (fact.associationId && !associations.has(fact.associationId)) {
      issues.push(structuralIssue(
        "unknown_fact_association",
        `证据事实 ${fact.id} 引用了不存在的交易关联`,
        { factId: fact.id, associationId: fact.associationId },
      ))
    }
    for (const dependencyId of fact.dependsOnFactIds) {
      if (!facts.has(dependencyId)) {
        issues.push(structuralIssue(
          "unknown_fact_dependency",
          `证据事实 ${fact.id} 引用了不存在的依赖事实`,
          { factId: fact.id },
        ))
      }
    }
    for (const dependencyId of duplicates(fact.dependsOnFactIds)) {
      issues.push(structuralIssue(
        "duplicate_fact_dependency",
        `证据事实 ${fact.id} 重复引用依赖 ${dependencyId}`,
        { factId: fact.id },
      ))
    }
  }

  for (const association of input.packet.associations) {
    for (const factId of duplicates(association.factIds)) {
      issues.push(structuralIssue(
        "duplicate_association_fact_reference",
        `交易关联 ${association.id} 重复引用事实 ${factId}`,
        { associationId: association.id, factId },
      ))
    }
    for (const factId of association.factIds) {
      const referencedFact = facts.get(factId)
      if (!referencedFact) {
        issues.push(structuralIssue(
          "unknown_association_fact",
          `交易关联 ${association.id} 引用了不存在的事实`,
          { associationId: association.id, factId },
        ))
      } else if (referencedFact.associationId !== association.id) {
        issues.push(structuralIssue(
          "association_reverse_membership_mismatch",
          `交易关联 ${association.id} 引用的事实未反向绑定到该关联`,
          { associationId: association.id, factId },
        ))
      }
    }
    for (const matched of association.matchedIdentifiers) {
      if (matched.factIds[0] === matched.factIds[1]) {
        issues.push(structuralIssue(
          "duplicate_matched_identifier_fact",
          `交易关联 ${association.id} 的稳定标识重复引用同一事实`,
          { associationId: association.id, factId: matched.factIds[0] },
        ))
      }
      for (const factId of matched.factIds) {
        if (!facts.has(factId)) {
          issues.push(structuralIssue(
            "unknown_matched_identifier_fact",
            `交易关联 ${association.id} 的稳定标识引用了不存在的事实`,
            { associationId: association.id, factId },
          ))
        }
      }
    }
    for (const hint of association.lookupHints) {
      for (const factId of duplicates(hint.factIds)) {
        issues.push(structuralIssue(
          "duplicate_lookup_hint_fact",
          `交易关联 ${association.id} 的候选线索重复引用事实 ${factId}`,
          { associationId: association.id, factId },
        ))
      }
      for (const factId of hint.factIds) {
        if (!facts.has(factId)) {
          issues.push(structuralIssue(
            "unknown_lookup_hint_fact",
            `交易关联 ${association.id} 的候选线索引用了不存在的事实`,
            { associationId: association.id, factId },
          ))
        }
      }
    }
    for (const conflict of association.conflicts) {
      if (conflict.leftFactId === conflict.rightFactId) {
        issues.push(structuralIssue(
          "self_referencing_association_conflict",
          `交易关联 ${association.id} 的冲突不能引用同一事实`,
          { associationId: association.id, factId: conflict.leftFactId },
        ))
      }
      for (const factId of [conflict.leftFactId, conflict.rightFactId]) {
        if (!facts.has(factId)) {
          issues.push(structuralIssue(
            "unknown_conflict_fact",
            `交易关联 ${association.id} 的冲突引用了不存在的事实`,
            { associationId: association.id, factId },
          ))
        }
      }
    }
  }

  input.packet.facts.forEach((fact) => {
    if (!fact.associationId) return
    const association = associations.get(fact.associationId)
    if (association && !association.factIds.includes(fact.id)) {
      issues.push(structuralIssue(
        "association_membership_mismatch",
        `证据事实 ${fact.id} 未登记在其交易关联中`,
        { factId: fact.id, associationId: fact.associationId },
      ))
    }
  })

  input.claims.forEach((answerClaim, claimIndex) => {
    if (!evidenceSourceMatchesProvenance(answerClaim.provenance, answerClaim.evidenceSource)) {
      issues.push(structuralIssue(
        "provenance_evidence_source_mismatch",
        `最终事实声明 ${claimIndex + 1} 的 provenance=${answerClaim.provenance} 与 evidenceSource=${answerClaim.evidenceSource} 不匹配`,
        { claimIndex, factId: answerClaim.factId },
      ))
    }
    const referencedFact = facts.get(answerClaim.factId)
    if (!referencedFact) {
      issues.push(structuralIssue(
        "unknown_answer_claim_fact",
        `最终事实声明 ${claimIndex + 1} 引用了不存在的事实`,
        { claimIndex, factId: answerClaim.factId },
      ))
    } else if (answerClaim.provenance !== referencedFact.provenance
      || answerClaim.evidenceSource !== referencedFact.evidenceSource
      || answerClaim.evidence !== referencedFact.evidence) {
      issues.push(structuralIssue(
        "answer_claim_fact_metadata_mismatch",
        `最终事实声明 ${claimIndex + 1} 的来源与其引用事实 ${answerClaim.factId} 不一致`,
        { claimIndex, factId: answerClaim.factId },
      ))
    }
  })
  for (const factId of duplicates(input.claims.map((answerClaim) => answerClaim.factId))) {
    issues.push(structuralIssue(
      "duplicate_answer_claim_fact",
      `最终事实声明重复引用事实 ${factId}`,
      { factId },
    ))
  }

  for (const factId of duplicates(input.responsibility.factIds)) {
    issues.push(structuralIssue(
      "duplicate_responsibility_fact_reference",
      `责任判断重复引用证据事实 ${factId}`,
      { factId },
    ))
  }
  for (const source of duplicates(input.responsibility.evidenceSources)) {
    issues.push(structuralIssue(
      "duplicate_responsibility_evidence_source",
      `责任判断重复声明证据来源 ${source}`,
    ))
  }
  for (const factId of input.responsibility.factIds) {
    if (!facts.has(factId)) {
      issues.push(structuralIssue(
        "unknown_responsibility_fact",
        `责任判断引用了不存在的证据事实 ${factId}`,
        { factId },
      ))
    }
  }
  const unknownResponsibility = input.responsibility.party === "unknown"
    || input.responsibility.party === "not_applicable"
  const validResponsibilityState = input.responsibility.party === "unknown"
    ? input.responsibility.certainty === "unknown"
    : input.responsibility.party === "not_applicable"
      ? input.responsibility.certainty === "not_applicable"
      : input.responsibility.certainty === "confirmed" || input.responsibility.certainty === "inference"
  if (!validResponsibilityState) {
    issues.push(structuralIssue(
      "responsibility_state_mismatch",
      `责任 party=${input.responsibility.party} 与 certainty=${input.responsibility.certainty} 状态不匹配`,
    ))
  }
  if (unknownResponsibility && input.responsibility.factIds.length > 0) {
    issues.push(structuralIssue(
      "unexpected_responsibility_fact_reference",
      "未知或不适用责任不能引用责任证据事实",
    ))
  }
  if (unknownResponsibility && input.responsibility.evidenceSources.length > 0) {
    issues.push(structuralIssue(
      "unexpected_responsibility_evidence_source",
      "未知或不适用责任不能声明责任证据来源",
    ))
  }
  if (!unknownResponsibility
    && ["confirmed", "inference"].includes(input.responsibility.certainty)
    && input.responsibility.factIds.length === 0) {
    issues.push(structuralIssue(
      "missing_responsibility_fact_reference",
      "已知责任的确认或推断必须引用至少一项具体事实",
    ))
  }
  if (!unknownResponsibility
    && input.responsibility.factIds.every((factId) => facts.has(factId))) {
    const citedSources = input.responsibility.factIds.map((factId) => facts.get(factId)!.evidenceSource)
    if (!sameStringSet(input.responsibility.evidenceSources, citedSources)) {
      issues.push(structuralIssue(
        "responsibility_evidence_source_mismatch",
        "责任 evidenceSources 必须与 factIds 直接引用事实的来源集合完全一致",
      ))
    }
  }

  const visitState = new Map<string, "visiting" | "visited">()
  const visit = (factId: string): void => {
    const state = visitState.get(factId)
    if (state === "visited") return
    if (state === "visiting") {
      issues.push(structuralIssue(
        "fact_dependency_cycle",
        `证据事实 ${factId} 存在循环依赖`,
        { factId },
      ))
      return
    }
    visitState.set(factId, "visiting")
    for (const dependencyId of facts.get(factId)?.dependsOnFactIds ?? []) {
      if (facts.has(dependencyId)) visit(dependencyId)
    }
    visitState.set(factId, "visited")
  }
  for (const factId of facts.keys()) visit(factId)

  if (issues.length > 0) throw new EvidenceBindingStructuralError(issues)
  return facts
}

const messageTransactionProvenances = new Set<EvidenceFact["provenance"]>([
  "user_report",
])
const runtimeTransactionProvenances = new Set<EvidenceFact["provenance"]>([
  "request", "response", "callback", "runtime",
])
const runtimeTransactionEvidenceSources = new Set<EvidenceFact["evidenceSource"]>([
  "server", "log", "database", "redis",
])

function trustworthyIdentifierFact(fact: EvidenceFact): boolean {
  return fact.certainty !== "inferred"
    && ((messageTransactionProvenances.has(fact.provenance) && fact.evidenceSource === "message")
      || (runtimeTransactionProvenances.has(fact.provenance)
        && runtimeTransactionEvidenceSources.has(fact.evidenceSource)))
}

function trustworthyBankReferenceMeaningFact(fact: EvidenceFact): boolean {
  return fact.certainty === "confirmed"
    && ((fact.provenance === "code" && fact.evidenceSource === "code")
      || (fact.provenance === "document" && fact.evidenceSource === "document"))
}

function dependsOnBankReferenceMeaning(
  fact: EvidenceFact,
  facts: Map<string, EvidenceFact>,
  visited = new Set<string>(),
): boolean {
  if (visited.has(fact.id)) return false
  visited.add(fact.id)
  return fact.dependsOnFactIds.some((dependencyId) => {
    const dependency = facts.get(dependencyId)
    return dependency
      ? trustworthyBankReferenceMeaningFact(dependency)
        || dependsOnBankReferenceMeaning(dependency, facts, visited)
      : false
  })
}

function validIdentifierMatches(
  association: EvidenceAssociation,
  facts: Map<string, EvidenceFact>,
  issues: EvidenceBindingIssue[],
): EvidenceAssociation["matchedIdentifiers"] {
  return association.matchedIdentifiers.filter((matched) => {
    const left = facts.get(matched.factIds[0])!
    const right = facts.get(matched.factIds[1])!
    const bankReferenceMeaningEstablished = matched.kind !== "bank_reference"
      || (dependsOnBankReferenceMeaning(left, facts) && dependsOnBankReferenceMeaning(right, facts))
    const valid = left.id !== right.id
      && association.factIds.includes(left.id)
      && association.factIds.includes(right.id)
      && left.associationId === association.id
      && right.associationId === association.id
      && left.outboundSafe
      && right.outboundSafe
      && trustworthyIdentifierFact(left)
      && trustworthyIdentifierFact(right)
      && left.evidenceSource !== right.evidenceSource
      && left.identifiers.some((identifier) => identifier.kind === matched.kind && identifier.value === matched.value)
      && right.identifiers.some((identifier) => identifier.kind === matched.kind && identifier.value === matched.value)
      && bankReferenceMeaningEstablished
    if (!bankReferenceMeaningEstablished) {
      issues.push({
        code: "bank_reference_meaning_not_established",
        message: `交易关联 ${association.id} 的银行交易参考号缺少代码或接口契约事实确认字段含义`,
        associationId: association.id,
      })
    }
    if (!valid) {
      issues.push({
        code: "invalid_stable_identifier_match",
        message: `交易关联 ${association.id} 的稳定标识未在两个独立可信来源中逐字匹配`,
        associationId: association.id,
      })
    }
    return valid
  })
}

function relatedFacts(association: EvidenceAssociation, facts: Map<string, EvidenceFact>): EvidenceFact[] {
  return association.factIds.map((factId) => facts.get(factId)!)
}

function hasBusinessTypeConflict(association: EvidenceAssociation, facts: Map<string, EvidenceFact>): boolean {
  const businessTypes = new Set(relatedFacts(association, facts)
    .filter((fact) => fact.subjectKind === "transaction")
    .map((fact) => fact.businessType)
    .filter((businessType) => businessType !== "unknown" && businessType !== "not_applicable"))
  return businessTypes.size > 1
}

function enforceDisplayReportingBoundary(packet: EvidencePacket, issues: EvidenceBindingIssue[]): void {
  for (const fact of packet.facts) {
    if (fact.provenance !== "display") continue
    const valid = fact.evidenceSource === "message"
      && fact.certainty === "reported"
      && fact.subjectKind === "general"
      && fact.businessType === "not_applicable"
      && fact.identifiers.length === 0
      && fact.associationId === null
      && fact.dependsOnFactIds.length === 0
    if (valid) continue
    fact.outboundSafe = false
    issues.push({
      code: "display_report_scope_invalid",
      message: `截图证据事实 ${fact.id} 只能作为脱离交易关联、无依赖和无稳定标识的一般报告性事实`,
      factId: fact.id,
      ...(fact.associationId ? { associationId: fact.associationId } : {}),
    })
  }
}

function associationsWithAmbiguousStableIdentifiers(packet: EvidencePacket): Set<string> {
  const mapping = new Map<string, { systemOrders: Set<string>; associationIds: Set<string> }>()
  for (const fact of packet.facts) {
    if (!fact.associationId) continue
    const systemOrderNumbers = fact.identifiers
      .filter((identifier) => identifier.kind === "system_order_no")
      .map((identifier) => identifier.value)
    if (systemOrderNumbers.length === 0) continue
    for (const identifier of fact.identifiers) {
      const key = `${identifier.kind}\u0000${identifier.value}`
      const entry = mapping.get(key) ?? { systemOrders: new Set<string>(), associationIds: new Set<string>() }
      systemOrderNumbers.forEach((orderNumber) => entry.systemOrders.add(orderNumber))
      entry.associationIds.add(fact.associationId)
      mapping.set(key, entry)
    }
  }
  const conflictingAssociations = new Set<string>()
  for (const entry of mapping.values()) {
    if (entry.systemOrders.size <= 1) continue
    entry.associationIds.forEach((associationId) => conflictingAssociations.add(associationId))
  }
  return conflictingAssociations
}

type StrongIdentityDimension =
  | "system_order_no"
  | "merchant_order_no"
  | "upstream_order_no"
  | "merchant_id"
  | "channel_id"
  | "business_type"

const orderIdentityKinds = new Set<EvidenceFact["identifiers"][number]["kind"]>([
  "system_order_no", "merchant_order_no", "upstream_order_no",
])

function normalizedNonEmpty(value: string): string | null {
  const normalized = value.trim()
  return normalized ? normalized : null
}

function associationsWithAmbiguousStrongIdentities(packet: EvidencePacket): Map<string, Set<StrongIdentityDimension>> {
  const hintsByFactId = new Map<string, Array<{ dimension: StrongIdentityDimension; value: string }>>()
  for (const association of packet.associations) {
    for (const hint of association.lookupHints) {
      const dimension = hint.kind === "merchant"
        ? "merchant_id"
        : hint.kind === "channel"
          ? "channel_id"
          : null
      if (!dimension) continue
      for (const factId of hint.factIds) {
        const hints = hintsByFactId.get(factId) ?? []
        hints.push({ dimension, value: hint.value })
        hintsByFactId.set(factId, hints)
      }
    }
  }
  const stableMappings = new Map<string, {
    associationIds: Set<string>
    dimensions: Map<StrongIdentityDimension, Set<string>>
  }>()

  for (const fact of packet.facts) {
    if (!fact.associationId || fact.identifiers.length === 0) continue
    const dimensions = new Map<StrongIdentityDimension, Set<string>>()
    const addDimension = (dimension: StrongIdentityDimension, rawValue: string): void => {
      const value = normalizedNonEmpty(rawValue)
      if (!value) return
      const values = dimensions.get(dimension) ?? new Set<string>()
      values.add(value)
      dimensions.set(dimension, values)
    }

    for (const identifier of fact.identifiers) {
      if (orderIdentityKinds.has(identifier.kind)) addDimension(identifier.kind as StrongIdentityDimension, identifier.value)
    }
    if (fact.subjectKind === "transaction"
      && fact.businessType !== "unknown"
      && fact.businessType !== "not_applicable") {
      addDimension("business_type", fact.businessType)
    }
    for (const hint of hintsByFactId.get(fact.id) ?? []) {
      addDimension(hint.dimension, hint.value)
    }

    for (const identifier of fact.identifiers) {
      const value = normalizedNonEmpty(identifier.value)
      if (!value) continue
      const key = `${identifier.kind}\u0000${value}`
      const entry = stableMappings.get(key) ?? {
        associationIds: new Set<string>(),
        dimensions: new Map<StrongIdentityDimension, Set<string>>(),
      }
      entry.associationIds.add(fact.associationId)
      for (const [dimension, values] of dimensions) {
        const merged = entry.dimensions.get(dimension) ?? new Set<string>()
        values.forEach((identityValue) => merged.add(identityValue))
        entry.dimensions.set(dimension, merged)
      }
      stableMappings.set(key, entry)
    }
  }

  const ambiguousAssociations = new Map<string, Set<StrongIdentityDimension>>()
  for (const entry of stableMappings.values()) {
    const ambiguousDimensions = [...entry.dimensions.entries()]
      .filter(([, values]) => values.size > 1)
      .map(([dimension]) => dimension)
    if (ambiguousDimensions.length === 0) continue
    for (const associationId of entry.associationIds) {
      const dimensions = ambiguousAssociations.get(associationId) ?? new Set<StrongIdentityDimension>()
      ambiguousDimensions.forEach((dimension) => dimensions.add(dimension))
      ambiguousAssociations.set(associationId, dimensions)
    }
  }
  return ambiguousAssociations
}

function associationWideStrongIdentityConflicts(packet: EvidencePacket): Map<string, Set<StrongIdentityDimension>> {
  const facts = new Map(packet.facts.map((fact) => [fact.id, fact]))
  const conflicts = new Map<string, Set<StrongIdentityDimension>>()
  for (const association of packet.associations) {
    const values = new Map<StrongIdentityDimension, Set<string>>()
    const addValue = (dimension: StrongIdentityDimension, rawValue: string): void => {
      const value = normalizedNonEmpty(rawValue)
      if (!value) return
      const dimensionValues = values.get(dimension) ?? new Set<string>()
      dimensionValues.add(value)
      values.set(dimension, dimensionValues)
    }
    for (const factId of association.factIds) {
      const fact = facts.get(factId)
      if (!fact) continue
      for (const identifier of fact.identifiers) {
        if (orderIdentityKinds.has(identifier.kind)) {
          addValue(identifier.kind as StrongIdentityDimension, identifier.value)
        }
      }
      if (fact.subjectKind === "transaction"
        && fact.businessType !== "unknown"
        && fact.businessType !== "not_applicable") {
        addValue("business_type", fact.businessType)
      }
    }
    for (const hint of association.lookupHints) {
      if (hint.kind === "merchant") addValue("merchant_id", hint.value)
      if (hint.kind === "channel") addValue("channel_id", hint.value)
    }
    const ambiguousDimensions = [...values.entries()]
      .filter(([, dimensionValues]) => dimensionValues.size > 1)
      .map(([dimension]) => dimension)
    if (ambiguousDimensions.length > 0) conflicts.set(association.id, new Set(ambiguousDimensions))
  }
  return conflicts
}

function normalizeAssociations(
  packet: EvidencePacket,
  facts: Map<string, EvidenceFact>,
  issues: EvidenceBindingIssue[],
  shouldNormalize: (association: EvidenceAssociation) => boolean = () => true,
): void {
  const identifierMappingConflicts = associationsWithAmbiguousStableIdentifiers(packet)
  const strongIdentityAmbiguities = associationsWithAmbiguousStrongIdentities(packet)
  const associationIdentityConflicts = associationWideStrongIdentityConflicts(packet)
  for (const association of packet.associations) {
    if (!shouldNormalize(association)) continue
    const declaredConfirmed = association.status === "confirmed"
    const validMatches = validIdentifierMatches(association, facts, issues)
    association.matchedIdentifiers = validMatches

    const businessTypeConflict = hasBusinessTypeConflict(association, facts)
    const identifierMappingConflict = identifierMappingConflicts.has(association.id)
    const strongIdentityAmbiguity = strongIdentityAmbiguities.has(association.id)
    const associationIdentityConflict = associationIdentityConflicts.get(association.id)
    const declaredConflict = association.conflicts.length > 0
    if (businessTypeConflict) {
      issues.push({
        code: "association_business_type_conflict",
        message: `交易关联 ${association.id} 存在业务类型冲突`,
        associationId: association.id,
      })
    }
    if (identifierMappingConflict) {
      issues.push({
        code: "stable_identifier_maps_multiple_orders",
        message: `交易关联 ${association.id} 的同一稳定标识指向多个系统订单`,
        associationId: association.id,
      })
    }
    if (strongIdentityAmbiguity) {
      issues.push({
        code: "stable_identifier_strong_identity_ambiguity",
        message: `交易关联 ${association.id} 的同一稳定标识关联了多个不一致的强身份值`,
        associationId: association.id,
      })
    }
    if (associationIdentityConflict) {
      issues.push({
        code: "association_strong_identity_conflict",
        message: `交易关联 ${association.id} 内存在多个不一致的强身份值：${[...associationIdentityConflict].join(",")}`,
        associationId: association.id,
      })
    }
    if (declaredConflict) {
      issues.push({
        code: "association_declared_conflict",
        message: `交易关联 ${association.id} 存在尚未解除的对象冲突`,
        associationId: association.id,
      })
    }
    const missingStableMatch = declaredConfirmed && validMatches.length === 0
    if (missingStableMatch) {
      issues.push({
        code: "association_missing_stable_match",
        message: `交易关联 ${association.id} 缺少两个独立来源完全一致的稳定标识`,
        associationId: association.id,
      })
    }

    if (businessTypeConflict || declaredConflict || association.status === "conflicting") {
      association.status = "conflicting"
      continue
    }
    if (identifierMappingConflict || strongIdentityAmbiguity || associationIdentityConflict || missingStableMatch) {
      association.status = "unconfirmed"
      continue
    }
  }
}

function transactionDependencyAssociations(
  fact: EvidenceFact,
  facts: Map<string, EvidenceFact>,
  visited = new Set<string>(),
): Set<string | null> {
  if (visited.has(fact.id)) return new Set<string | null>()
  visited.add(fact.id)
  const associationIds = new Set<string | null>()
  for (const dependencyId of fact.dependsOnFactIds) {
    const dependency = facts.get(dependencyId)
    if (!dependency) continue
    if (dependency.subjectKind === "transaction") associationIds.add(dependency.associationId)
    for (const associationId of transactionDependencyAssociations(dependency, facts, visited)) {
      associationIds.add(associationId)
    }
  }
  return associationIds
}

function connectedToMatchedEndpoint(
  fact: EvidenceFact,
  associationId: string,
  endpointFactIds: Set<string>,
  facts: Map<string, EvidenceFact>,
  visited = new Set<string>(),
): boolean {
  if (endpointFactIds.has(fact.id)) return true
  if (visited.has(fact.id)) return false
  visited.add(fact.id)
  return fact.dependsOnFactIds.some((dependencyId) => {
    const dependency = facts.get(dependencyId)
    if (!dependency) return false
    if (dependency.subjectKind === "transaction" && dependency.associationId !== associationId) return false
    return connectedToMatchedEndpoint(dependency, associationId, endpointFactIds, facts, visited)
  })
}

function dependsOnDisplayReport(
  fact: EvidenceFact,
  facts: Map<string, EvidenceFact>,
  visited = new Set<string>(),
): boolean {
  if (visited.has(fact.id)) return false
  visited.add(fact.id)
  return fact.dependsOnFactIds.some((dependencyId) => {
    const dependency = facts.get(dependencyId)
    return dependency
      ? dependency.provenance === "display" || dependsOnDisplayReport(dependency, facts, visited)
      : false
  })
}

function dependencyClosureContains(
  fact: EvidenceFact,
  facts: Map<string, EvidenceFact>,
  predicate: (dependency: EvidenceFact) => boolean,
  visited = new Set<string>(),
): boolean {
  if (visited.has(fact.id)) return false
  visited.add(fact.id)
  return fact.dependsOnFactIds.some((dependencyId) => {
    const dependency = facts.get(dependencyId)
    return dependency ? predicate(dependency) || dependencyClosureContains(dependency, facts, predicate, visited) : false
  })
}

function responsibilityFactHasForbiddenSource(
  fact: EvidenceFact,
  facts: Map<string, EvidenceFact>,
  visited = new Set<string>(),
): boolean {
  if (!evidenceProvenanceCanSupportCurrentResponsibility(fact.provenance)) return true
  if (visited.has(fact.id)) return false
  visited.add(fact.id)
  return fact.dependsOnFactIds.some((dependencyId) => {
    const dependency = facts.get(dependencyId)
    return dependency ? responsibilityFactHasForbiddenSource(dependency, facts, visited) : true
  })
}

function propagateUnsafeDependencies(
  packet: EvidencePacket,
  facts: Map<string, EvidenceFact>,
  issues: EvidenceBindingIssue[],
): void {
  let changed = true
  while (changed) {
    changed = false
    for (const fact of packet.facts) {
      if (!fact.outboundSafe) continue
      const unsafeDependency = fact.dependsOnFactIds.find((dependencyId) => facts.get(dependencyId)?.outboundSafe === false)
      if (!unsafeDependency) continue
      fact.outboundSafe = false
      changed = true
      issues.push({
        code: "dependent_fact_not_outbound_safe",
        message: `证据事实 ${fact.id} 依赖不可出站的交易事实`,
        factId: fact.id,
      })
    }
  }
}

function enforceIntrinsicOutboundSafety(
  packet: EvidencePacket,
  issues: EvidenceBindingIssue[],
): Map<string, EvidenceFact> {
  const facts = new Map(packet.facts.map((fact) => [fact.id, fact]))

  for (const fact of packet.facts) {
    const transactionAssociations = transactionDependencyAssociations(fact, facts)
    const nonNullAssociations = new Set([...transactionAssociations].filter((value): value is string => value !== null))
    const crossesAssociation = fact.subjectKind === "transaction" && fact.associationId
      ? [...transactionAssociations].some((associationId) => associationId !== fact.associationId)
      : !fact.associationId && nonNullAssociations.size > 1
    if (!crossesAssociation) continue
    fact.outboundSafe = false
    issues.push({
      code: "cross_association_transaction_dependency",
      message: `证据事实 ${fact.id} 的推导依赖跨越了不同交易关联`,
      factId: fact.id,
      ...(fact.associationId ? { associationId: fact.associationId } : {}),
    })
  }

  for (const fact of packet.facts) {
    if (fact.subjectKind !== "transaction" || !dependsOnDisplayReport(fact, facts)) continue
    fact.outboundSafe = false
    issues.push({
      code: "transaction_depends_on_display_report",
      message: `交易证据事实 ${fact.id} 直接或间接依赖报告性截图事实，不能用于当前交易绑定`,
      factId: fact.id,
      ...(fact.associationId ? { associationId: fact.associationId } : {}),
    })
  }

  for (const fact of packet.facts) {
    if (fact.subjectKind !== "transaction"
      || !dependencyClosureContains(fact, facts, (dependency) => dependency.evidenceSource === "memory")) continue
    fact.outboundSafe = false
    issues.push({
      code: "transaction_depends_on_memory_evidence",
      message: `交易证据事实 ${fact.id} 直接或间接依赖 AI 记忆，不能用于当前交易事实`,
      factId: fact.id,
      ...(fact.associationId ? { associationId: fact.associationId } : {}),
    })
  }

  for (const fact of packet.facts) {
    if (fact.certainty !== "confirmed" || !dependencyClosureContains(
      fact,
      facts,
      (dependency) => dependency.certainty === "inferred"
        || dependency.provenance === "inference"
        || dependency.evidenceSource === "inference",
    )) continue
    fact.outboundSafe = false
    issues.push({
      code: "confirmed_fact_depends_on_inference",
      message: `已确认事实 ${fact.id} 的依赖闭包含推断事实，不能把推断前提升级为确认结论`,
      factId: fact.id,
      ...(fact.associationId ? { associationId: fact.associationId } : {}),
    })
  }

  propagateUnsafeDependencies(packet, facts, issues)
  return facts
}

function associationSafetyState(packet: EvidencePacket): string {
  return JSON.stringify({
    facts: packet.facts.map((fact) => [fact.id, fact.outboundSafe]),
    associations: packet.associations.map((association) => [
      association.id,
      association.status,
      association.matchedIdentifiers.map((matched) => [matched.kind, matched.value, ...matched.factIds]),
    ]),
  })
}

function settleAssociationSafety(
  packet: EvidencePacket,
  facts: Map<string, EvidenceFact>,
  issues: EvidenceBindingIssue[],
): void {
  let previousState: string
  do {
    previousState = associationSafetyState(packet)
    const associations = new Map(packet.associations.map((association) => [association.id, association]))

    for (const association of packet.associations) {
      if (association.status !== "confirmed") continue
      const endpointFactIds = new Set(association.matchedIdentifiers.flatMap((matched) => matched.factIds))
      for (const factId of association.factIds) {
        const fact = facts.get(factId)!
        if (fact.subjectKind !== "transaction" || !fact.outboundSafe) continue
        if (connectedToMatchedEndpoint(fact, association.id, endpointFactIds, facts)) continue
        fact.outboundSafe = false
        issues.push({
          code: "transaction_fact_not_linked_to_stable_match",
          message: `证据事实 ${fact.id} 未通过同一交易关联的依赖链连接到稳定标识匹配端点`,
          associationId: association.id,
          factId: fact.id,
        })
      }
    }

    for (const fact of packet.facts) {
      if (fact.subjectKind !== "transaction") continue
      const association = fact.associationId ? associations.get(fact.associationId) : undefined
      if (!association || association.status !== "confirmed") fact.outboundSafe = false
    }

    propagateUnsafeDependencies(packet, facts, issues)
    normalizeAssociations(packet, facts, issues, (association) => association.status === "confirmed")
  } while (associationSafetyState(packet) !== previousState)
}

const strictProvenance = new Set<EvidenceFact["provenance"]>(["request", "response", "callback", "runtime"])

function dependsOnStrictFact(fact: EvidenceFact, facts: Map<string, EvidenceFact>, visited = new Set<string>()): boolean {
  if (strictProvenance.has(fact.provenance)) return true
  if (visited.has(fact.id)) return false
  visited.add(fact.id)
  return fact.dependsOnFactIds.some((dependencyId) => {
    const dependency = facts.get(dependencyId)
    return dependency ? dependsOnStrictFact(dependency, facts, visited) : false
  })
}

export function applyEvidenceBindingGate(input: EvidenceBindingGateInput): EvidenceBindingGateResult {
  validateStructure(input)
  const trustedPacket = structuredClone(input.packet)
  const issues: EvidenceBindingIssue[] = []
  enforceDisplayReportingBoundary(trustedPacket, issues)
  const trustedFacts = enforceIntrinsicOutboundSafety(trustedPacket, issues)
  normalizeAssociations(trustedPacket, trustedFacts, issues)
  settleAssociationSafety(trustedPacket, trustedFacts, issues)

  const knownResponsibility = !["unknown", "not_applicable"].includes(input.responsibility.party)
  if (knownResponsibility) {
    for (const factId of input.responsibility.factIds) {
      const fact = trustedFacts.get(factId)!
      if (responsibilityFactHasForbiddenSource(fact, trustedFacts)) {
        issues.push({
          code: "responsibility_fact_source_not_allowed",
          message: `责任事实 ${factId} 或其依赖闭包含不能作为当前责任依据的来源`,
          factId,
        })
      }
      if (!fact.outboundSafe) {
        issues.push({
          code: "responsibility_fact_not_outbound_safe",
          message: `责任事实 ${factId} 未通过证据出站门禁`,
          factId,
        })
      }
    }
  }

  input.claims.forEach((answerClaim, claimIndex) => {
    const fact = trustedFacts.get(answerClaim.factId)!
    if (!fact.outboundSafe) {
      issues.push({
        code: "claim_fact_not_outbound_safe",
        message: `最终事实声明 ${claimIndex + 1} 引用了不可出站的交易事实`,
        factId: fact.id,
        claimIndex,
      })
    }
  })

  const strictReviewRequired = trustedPacket.reviewLevel === "strict"
    || trustedPacket.associations.length > 0
    || issues.length > 0
    || input.claims.some((answerClaim) => dependsOnStrictFact(trustedFacts.get(answerClaim.factId)!, trustedFacts))
    || !["unknown", "not_applicable"].includes(input.responsibility.party)

  if (strictReviewRequired) trustedPacket.reviewLevel = "strict"

  return { packet: trustedPacket, issues, strictReviewRequired }
}
