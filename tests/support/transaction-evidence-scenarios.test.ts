import { describe, expect, it } from "vitest"

import { evidencePacketSchema } from "../../src/codex/schemas.js"
import { applyEvidenceBindingGate } from "../../src/support/evidence-binding-gate.js"
import {
  bankReferenceWithEstablishedMeaningScenario,
  bankReferenceWithoutEstablishedMeaningScenario,
  devaTransactionMismatchScenario,
  sameAmountAndTimeWithoutIdentifierScenario,
  sameIdentifierWithChannelConflictScenario,
  stableIdentifierPositiveScenario,
  transactionEvidenceScenarios,
  type TransactionEvidenceScenario,
} from "../fixtures/deva-transaction-mismatch.js"

function runScenario(scenario: TransactionEvidenceScenario) {
  return applyEvidenceBindingGate({
    packet: scenario.packet,
    claims: scenario.claims,
    responsibility: scenario.responsibility,
  })
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings)
  return []
}

function expectScenarioContract(scenario: TransactionEvidenceScenario): void {
  const result = runScenario(scenario)
  const association = result.packet.associations[0]
  const facts = new Map(result.packet.facts.map((fact) => [fact.id, fact]))
  const issueCodes = result.issues.map((issue) => issue.code)

  expect(association?.status).toBe(scenario.expected.associationStatus)
  for (const factId of scenario.expected.safeFactIds) {
    expect(facts.get(factId)?.outboundSafe, `${scenario.id}:${factId} should be safe`).toBe(true)
  }
  for (const factId of scenario.expected.unsafeFactIds) {
    expect(facts.get(factId)?.outboundSafe, `${scenario.id}:${factId} should be unsafe`).toBe(false)
  }
  for (const factId of scenario.expected.forbiddenClaimFactIds) {
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "claim_fact_not_outbound_safe",
      factId,
    }))
  }
  expect(issueCodes).toEqual(expect.arrayContaining(scenario.expected.requiredIssueCodes))
  expect(result.strictReviewRequired).toBe(true)
}

describe("synthetic transaction evidence scenario matrix", () => {
  it("contains only de-identified structured evidence and invented identifiers", () => {
    const factSurface = transactionEvidenceScenarios.flatMap((scenario) => scenario.packet.facts)
    const associationSurface = transactionEvidenceScenarios.flatMap((scenario) => scenario.packet.associations)
    const matchedIdentifierSurface = associationSurface.flatMap((association) => association.matchedIdentifiers)
    const lookupHintSurface = associationSurface.flatMap((association) => association.lookupHints)
    const conflictSurface = associationSurface.flatMap((association) => association.conflicts)
    const freeTextSurface = transactionEvidenceScenarios.flatMap((scenario) => [
      scenario.packet.communication,
      scenario.packet.requiredAnswerPoints,
      scenario.packet.unknowns,
      scenario.packet.handlingNotes,
    ])
    const redactedSurface = [
      factSurface,
      associationSurface,
      matchedIdentifierSurface,
      lookupHintSurface,
      conflictSurface,
      freeTextSurface,
    ]
    const serialized = JSON.stringify(redactedSurface)
    const identifiers = transactionEvidenceScenarios.flatMap((scenario) => [
      ...scenario.packet.facts.flatMap((fact) => fact.identifiers.map((identifier) => identifier.value)),
      ...scenario.packet.associations.flatMap((association) =>
        association.matchedIdentifiers.map((identifier) => identifier.value),
      ),
    ])
    const allStrings = collectStrings(redactedSurface)
    const timestamps = allStrings.flatMap((value) => value.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z\b/gu) ?? [])

    expect(serialized).toContain("XDPay")
    expect(serialized).toContain("AOHPay")
    expect(matchedIdentifierSurface.length).toBeGreaterThan(0)
    expect(lookupHintSurface.length).toBeGreaterThan(0)
    expect(conflictSurface.length).toBeGreaterThan(0)
    expect(freeTextSurface.length).toBeGreaterThan(0)
    expect(transactionEvidenceScenarios.every((scenario) => evidencePacketSchema.safeParse(scenario.packet).success)).toBe(true)
    expect(identifiers.length).toBeGreaterThan(0)
    expect(identifiers.every((value) => value.startsWith("SYN-"))).toBe(true)
    expect(timestamps.length).toBeGreaterThan(0)
    expect(timestamps.every((value) => value.startsWith("2099-"))).toBe(true)
    expect(serialized).not.toMatch(
      /(?:api[_ -]?key|token|signature|password|private[_ -]?key|jdbc:|mysql:|ssh-rsa|BEGIN [A-Z ]+ KEY|https?:\/\/)/iu,
    )
    expect(serialized).not.toMatch(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu)
    expect(serialized).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/u)
    expect(serialized).not.toMatch(/\b(?:\d[ -]?){12,19}\b/u)
    expect(serialized).not.toMatch(/[A-Za-z0-9+/]{80,}={0,2}/u)
  })

  it("keeps the channel/business mismatch and every candidate-derived claim outbound unsafe", () => {
    expectScenarioContract(devaTransactionMismatchScenario)

    const result = runScenario(devaTransactionMismatchScenario)
    expect(result.packet.associations[0]).toMatchObject({
      status: "conflicting",
      matchedIdentifiers: [],
      lookupHints: expect.arrayContaining([
        expect.objectContaining({ kind: "amount" }),
        expect.objectContaining({ kind: "time" }),
      ]),
      conflicts: expect.arrayContaining([
        expect.objectContaining({ field: "business_type" }),
        expect.objectContaining({ field: "channel" }),
      ]),
    })
  })

  it("does not confirm the same amount and nearby timestamp without a stable identifier", () => {
    expectScenarioContract(sameAmountAndTimeWithoutIdentifierScenario)

    const result = runScenario(sameAmountAndTimeWithoutIdentifierScenario)
    expect(result.packet.associations[0]).toMatchObject({
      status: "unconfirmed",
      matchedIdentifiers: [],
    })
    expect(result.packet.communication.intent).toBe("minimal_clarification")
    expect(result.packet.unknowns.length).toBeGreaterThan(0)
  })

  it("confirms an exact stable identifier in user and current-service database evidence", () => {
    expectScenarioContract(stableIdentifierPositiveScenario)

    const result = runScenario(stableIdentifierPositiveScenario)
    expect(result.packet.associations[0]?.matchedIdentifiers).toEqual([
      expect.objectContaining({
        kind: "merchant_order_no",
        factIds: ["F1", "F2"],
      }),
    ])
    expect(result.issues).toEqual([])
  })

  it("keeps an exact identifier conflicting when the declared channels differ", () => {
    expectScenarioContract(sameIdentifierWithChannelConflictScenario)

    const result = runScenario(sameIdentifierWithChannelConflictScenario)
    expect(result.packet.associations[0]).toMatchObject({
      status: "conflicting",
      matchedIdentifiers: [expect.objectContaining({ kind: "merchant_order_no" })],
      conflicts: [expect.objectContaining({ field: "channel" })],
    })
  })

  it("uses a bank reference only when code evidence establishes the field meaning", () => {
    expectScenarioContract(bankReferenceWithEstablishedMeaningScenario)

    const packet = bankReferenceWithEstablishedMeaningScenario.packet
    const semanticFact = packet.facts.find((fact) => fact.id === "F1")
    const matchedFacts = packet.facts.filter((fact) => ["F2", "F3"].includes(fact.id))
    expect(semanticFact).toMatchObject({ provenance: "code", evidenceSource: "code" })
    expect(matchedFacts.every((fact) => fact.dependsOnFactIds.includes("F1"))).toBe(true)
    expect(packet.associations[0]?.matchedIdentifiers).toEqual([
      expect.objectContaining({ kind: "bank_reference", factIds: ["F2", "F3"] }),
    ])

    const contractVariant = structuredClone(bankReferenceWithEstablishedMeaningScenario)
    const contractFact = contractVariant.packet.facts.find((fact) => fact.id === "F1")!
    contractFact.provenance = "document"
    contractFact.evidenceSource = "document"
    expect(runScenario(contractVariant).packet.associations[0]?.status).toBe("confirmed")
  })

  it("does not treat an ordinary runtime/database dependency as a field contract", () => {
    const runtimeOnlyVariant = structuredClone(bankReferenceWithEstablishedMeaningScenario)
    const runtimeFact = runtimeOnlyVariant.packet.facts.find((fact) => fact.id === "F1")!
    runtimeFact.provenance = "runtime"
    runtimeFact.evidenceSource = "database"

    const result = runScenario(runtimeOnlyVariant)
    expect(result.packet.associations[0]).toMatchObject({ status: "unconfirmed", matchedIdentifiers: [] })
    expect(result.issues.map((issue) => issue.code)).toContain("bank_reference_meaning_not_established")
    expect(result.packet.facts.filter((fact) => ["F2", "F3"].includes(fact.id)).every((fact) =>
      fact.outboundSafe === false,
    )).toBe(true)
  })

  it("rejects a reference-like value when no fact establishes bank-reference semantics", () => {
    expectScenarioContract(bankReferenceWithoutEstablishedMeaningScenario)

    const result = runScenario(bankReferenceWithoutEstablishedMeaningScenario)
    expect(bankReferenceWithoutEstablishedMeaningScenario.packet.facts).not.toContainEqual(expect.objectContaining({
      provenance: "code",
      evidenceSource: "code",
    }))
    expect(bankReferenceWithoutEstablishedMeaningScenario.packet.facts.every((fact) =>
      fact.identifiers.some((identifier) => identifier.kind === "bank_reference")
        && fact.dependsOnFactIds.length === 0,
    )).toBe(true)
    expect(bankReferenceWithoutEstablishedMeaningScenario.packet.associations[0]?.matchedIdentifiers).toEqual([
      expect.objectContaining({ kind: "bank_reference", factIds: ["F1", "F2"] }),
    ])
    expect(result.packet.associations[0]).toMatchObject({
      status: "unconfirmed",
      matchedIdentifiers: [],
    })
  })
})
