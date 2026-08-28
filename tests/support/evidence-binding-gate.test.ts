import { describe, expect, it } from "vitest"

import type {
  AnswerDecision,
  EvidenceAssociation,
  EvidenceFact,
  EvidencePacket,
  ResponsibilityAssessment,
} from "../../src/codex/schemas.js"
import {
  applyEvidenceBindingGate,
  EvidenceBindingStructuralError,
} from "../../src/support/evidence-binding-gate.js"

function fact(id: string, overrides: Partial<EvidenceFact> = {}): EvidenceFact {
  return {
    id,
    statement: `fact ${id}`,
    provenance: "code",
    evidenceSource: "code",
    evidence: `evidence ${id}`,
    certainty: "confirmed",
    outboundSafe: true,
    subjectKind: "general",
    businessType: "not_applicable",
    identifiers: [],
    associationId: null,
    dependsOnFactIds: [],
    ...overrides,
  }
}

function association(overrides: Partial<EvidenceAssociation> = {}): EvidenceAssociation {
  return {
    id: "A1",
    subjectKind: "transaction",
    status: "confirmed",
    factIds: ["F1", "F2"],
    matchedIdentifiers: [{
      kind: "merchant_order_no",
      value: "M-001",
      factIds: ["F1", "F2"],
    }],
    lookupHints: [],
    conflicts: [],
    ...overrides,
  }
}

function packet(facts: EvidenceFact[], associations: EvidenceAssociation[] = []): EvidencePacket {
  return {
    version: "2",
    communication: { intent: "direct_answer", recipient: null, desiredOutcome: "回答当前问题" },
    facts,
    associations,
    requiredAnswerPoints: ["回答当前问题"],
    unknowns: [],
    handlingNotes: [],
    reviewLevel: "standard",
  }
}

function claim(
  factId: string,
  provenance: AnswerDecision["answerClaims"][number]["provenance"] = "runtime",
  explicitEvidenceSource?: AnswerDecision["answerClaims"][number]["evidenceSource"],
):
AnswerDecision["answerClaims"][number] {
  let evidenceSource: AnswerDecision["answerClaims"][number]["evidenceSource"]
  if (provenance === "user_report" || provenance === "display" || provenance === "recommendation") {
    evidenceSource = "message"
  } else if (provenance === "request" || provenance === "response"
    || provenance === "callback" || provenance === "runtime") {
    evidenceSource = "database"
  } else {
    evidenceSource = provenance
  }
  return {
    factId,
    statement: `claim ${factId}`,
    provenance,
    evidenceSource: explicitEvidenceSource ?? evidenceSource,
    evidence: `evidence ${factId}`,
  }
}

const unknownResponsibility: ResponsibilityAssessment = {
  party: "unknown",
  certainty: "unknown",
  evidenceSources: [],
  factIds: [],
}

function expectStructuralError(run: () => unknown): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(EvidenceBindingStructuralError)
  expect(caught).toMatchObject({
    name: "EvidenceBindingStructuralError",
    issues: expect.arrayContaining([expect.objectContaining({ code: expect.any(String) })]),
  })
}

function expectStructuralErrorCode(run: () => unknown, code: string): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(EvidenceBindingStructuralError)
  expect(caught).toMatchObject({
    issues: expect.arrayContaining([expect.objectContaining({ code })]),
  })
}

function confirmedTransactionFacts(identifier: { kind: "merchant_order_no" | "system_order_no"; value: string }):
EvidenceFact[] {
  return [
    fact("F1", {
      provenance: "user_report",
      evidenceSource: "message",
      certainty: "reported",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [identifier],
      associationId: "A1",
    }),
    fact("F2", {
      provenance: "runtime",
      evidenceSource: "database",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [identifier],
      associationId: "A1",
    }),
  ]
}

function sharedRequestAcrossAssociations(options: {
  secondMerchantOrder: string
  secondChannel: string
}): EvidencePacket {
  const facts = [
    fact("F1", {
      provenance: "user_report",
      evidenceSource: "message",
      certainty: "reported",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [
        { kind: "request_id", value: "REQ-SHARED" },
        { kind: "merchant_order_no", value: "MERCHANT-ONE" },
        { kind: "upstream_order_no", value: "UPSTREAM-ONE" },
      ],
      associationId: "A1",
    }),
    fact("F2", {
      provenance: "runtime",
      evidenceSource: "database",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [
        { kind: "request_id", value: "REQ-SHARED" },
        { kind: "merchant_order_no", value: "MERCHANT-ONE" },
        { kind: "upstream_order_no", value: "UPSTREAM-ONE" },
      ],
      associationId: "A1",
    }),
    fact("F3", {
      provenance: "user_report",
      evidenceSource: "message",
      certainty: "reported",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [
        { kind: "request_id", value: "REQ-SHARED" },
        { kind: "merchant_order_no", value: options.secondMerchantOrder },
        { kind: "upstream_order_no", value: "UPSTREAM-ONE" },
      ],
      associationId: "A2",
    }),
    fact("F4", {
      provenance: "runtime",
      evidenceSource: "log",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [
        { kind: "request_id", value: "REQ-SHARED" },
        { kind: "merchant_order_no", value: options.secondMerchantOrder },
        { kind: "upstream_order_no", value: "UPSTREAM-ONE" },
      ],
      associationId: "A2",
    }),
  ]
  return packet(facts, [
    association({
      matchedIdentifiers: [{ kind: "request_id", value: "REQ-SHARED", factIds: ["F1", "F2"] }],
      lookupHints: [{ kind: "channel", value: "CHANNEL-ONE", factIds: ["F1", "F2"] }],
    }),
    association({
      id: "A2",
      factIds: ["F3", "F4"],
      matchedIdentifiers: [{ kind: "request_id", value: "REQ-SHARED", factIds: ["F3", "F4"] }],
      lookupHints: [{ kind: "channel", value: options.secondChannel, factIds: ["F3", "F4"] }],
    }),
  ])
}

function distinctConfirmedAssociations(): EvidencePacket {
  return packet([
    fact("F1", {
      provenance: "user_report",
      evidenceSource: "message",
      certainty: "reported",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [{ kind: "merchant_order_no", value: "MERCHANT-ONE" }],
      associationId: "A1",
    }),
    fact("F2", {
      provenance: "runtime",
      evidenceSource: "database",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [{ kind: "merchant_order_no", value: "MERCHANT-ONE" }],
      associationId: "A1",
    }),
    fact("F3", {
      provenance: "user_report",
      evidenceSource: "message",
      certainty: "reported",
      subjectKind: "transaction",
      businessType: "payment",
      identifiers: [{ kind: "merchant_order_no", value: "MERCHANT-TWO" }],
      associationId: "A2",
    }),
    fact("F4", {
      provenance: "callback",
      evidenceSource: "log",
      subjectKind: "transaction",
      businessType: "payment",
      identifiers: [{ kind: "merchant_order_no", value: "MERCHANT-TWO" }],
      associationId: "A2",
    }),
  ], [
    association({
      matchedIdentifiers: [{ kind: "merchant_order_no", value: "MERCHANT-ONE", factIds: ["F1", "F2"] }],
    }),
    association({
      id: "A2",
      factIds: ["F3", "F4"],
      matchedIdentifiers: [{ kind: "merchant_order_no", value: "MERCHANT-TWO", factIds: ["F3", "F4"] }],
    }),
  ])
}

describe("transaction evidence binding gate", () => {
  it("exposes a dedicated structural error instead of treating every exception as a gate rejection", () => {
    expect(EvidenceBindingStructuralError).toBeTypeOf("function")
  })

  it("confirms a transaction when a merchant order number matches two distinct non-inference sources", () => {
    const evidencePacket = packet(
      confirmedTransactionFacts({ kind: "merchant_order_no", value: "M-001" }),
      [association()],
    )

    const result = applyEvidenceBindingGate({
      packet: evidencePacket,
      claims: [claim("F2")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("confirmed")
    expect(result.packet.facts.map((item) => [item.id, item.outboundSafe])).toEqual([
      ["F1", true],
      ["F2", true],
    ])
    expect(result.issues).toEqual([])
    expect(result.strictReviewRequired).toBe(true)
  })

  it("confirms a system order number shared by callback and database evidence", () => {
    const facts = confirmedTransactionFacts({ kind: "system_order_no", value: "S-009" })
    facts[0] = fact("F1", {
      provenance: "callback",
      evidenceSource: "log",
      subjectKind: "transaction",
      businessType: "payment",
      identifiers: [{ kind: "system_order_no", value: "S-009" }],
      associationId: "A1",
    })
    facts[1] = fact("F2", {
      provenance: "runtime",
      evidenceSource: "database",
      subjectKind: "transaction",
      businessType: "payment",
      identifiers: [{ kind: "system_order_no", value: "S-009" }],
      associationId: "A1",
    })

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        matchedIdentifiers: [{ kind: "system_order_no", value: "S-009", factIds: ["F1", "F2"] }],
      })]),
      claims: [claim("F1", "callback", "log")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("confirmed")
    expect(result.issues).toEqual([])
  })

  it.each(["amount", "time", "recipient", "account", "merchant", "channel"] as const)(
    "%s lookup hints never confirm a transaction without a stable identifier",
    (kind) => {
      const facts = [
        fact("F1", {
          provenance: "display",
          evidenceSource: "message",
          certainty: "reported",
          subjectKind: "transaction",
          businessType: "collection",
          associationId: "A1",
        }),
        fact("F2", {
          provenance: "runtime",
          evidenceSource: "database",
          subjectKind: "transaction",
          businessType: "collection",
          associationId: "A1",
        }),
      ]
      const result = applyEvidenceBindingGate({
        packet: packet(facts, [association({
          matchedIdentifiers: [],
          lookupHints: [{ kind, value: "same candidate value", factIds: ["F1", "F2"] }],
        })]),
        claims: [claim("F2")],
        responsibility: unknownResponsibility,
      })

      expect(result.packet.associations[0]?.status).toBe("unconfirmed")
      expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([false, false])
      expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
        "association_missing_stable_match", "claim_fact_not_outbound_safe",
      ]))
    },
  )

  it("normalizes a collection-versus-payment association to conflicting", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "M-001" })
    facts[1] = { ...facts[1]!, businessType: "payment" }

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association()]),
      claims: [claim("F2")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("conflicting")
    expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([false, false])
    expect(result.issues.map((issue) => issue.code)).toContain("association_business_type_conflict")
  })

  it.each(["service", "merchant", "channel", "identifier"] as const)(
    "normalizes a declared %s conflict to conflicting",
    (field) => {
      const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "M-001" })
      const result = applyEvidenceBindingGate({
        packet: packet(facts, [association({
          conflicts: [{ field, leftFactId: "F1", rightFactId: "F2", summary: `${field} differs` }],
        })]),
        claims: [],
        responsibility: unknownResponsibility,
      })

      expect(result.packet.associations[0]?.status).toBe("conflicting")
      expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([false, false])
      expect(result.issues.map((issue) => issue.code)).toContain("association_declared_conflict")
    },
  )

  it("marks one stable identifier mapped to two system orders as unconfirmed", () => {
    const facts = [
      fact("F1", {
        provenance: "user_report",
        evidenceSource: "message",
        certainty: "reported",
        subjectKind: "transaction",
        businessType: "collection",
        identifiers: [
          { kind: "merchant_order_no", value: "M-DUP" },
          { kind: "system_order_no", value: "S-ONE" },
        ],
        associationId: "A1",
      }),
      fact("F2", {
        provenance: "runtime",
        evidenceSource: "database",
        subjectKind: "transaction",
        businessType: "collection",
        identifiers: [
          { kind: "merchant_order_no", value: "M-DUP" },
          { kind: "system_order_no", value: "S-TWO" },
        ],
        associationId: "A1",
      }),
    ]

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        matchedIdentifiers: [{ kind: "merchant_order_no", value: "M-DUP", factIds: ["F1", "F2"] }],
      })]),
      claims: [],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("unconfirmed")
    expect(result.issues.map((issue) => issue.code)).toContain("stable_identifier_maps_multiple_orders")
  })

  it("downgrades a confirmed association when one exact merchant order has two channel identities", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "MERCHANT-SHARED" })
    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        matchedIdentifiers: [{
          kind: "merchant_order_no", value: "MERCHANT-SHARED", factIds: ["F1", "F2"],
        }],
        lookupHints: [
          { kind: "channel", value: "CHANNEL-ONE", factIds: ["F1"] },
          { kind: "channel", value: "CHANNEL-TWO", factIds: ["F2"] },
        ],
        conflicts: [],
      })]),
      claims: [claim("F2")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("unconfirmed")
    expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([false, false])
    expect(result.issues.map((issue) => issue.code)).toContain("stable_identifier_strong_identity_ambiguity")
    expect(result.strictReviewRequired).toBe(true)
  })

  it("detects one request id mapped to different merchant orders without a system order number", () => {
    const result = applyEvidenceBindingGate({
      packet: sharedRequestAcrossAssociations({
        secondMerchantOrder: "MERCHANT-TWO",
        secondChannel: "CHANNEL-ONE",
      }),
      claims: [],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations.map((item) => item.status)).toEqual(["unconfirmed", "unconfirmed"])
    expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([false, false, false, false])
    expect(result.issues.filter((issue) => issue.code === "stable_identifier_strong_identity_ambiguity")).toHaveLength(2)
    expect(result.strictReviewRequired).toBe(true)
  })

  it("keeps shared stable identifiers confirmed when every strong identity dimension is consistent", () => {
    const result = applyEvidenceBindingGate({
      packet: sharedRequestAcrossAssociations({
        secondMerchantOrder: "MERCHANT-ONE",
        secondChannel: "CHANNEL-ONE",
      }),
      claims: [],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations.map((item) => item.status)).toEqual(["confirmed", "confirmed"])
    expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([true, true, true, true])
    expect(result.issues.map((issue) => issue.code)).not.toContain("stable_identifier_strong_identity_ambiguity")
  })

  it("downgrades an association when strong order identities conflict across separate unconnected facts", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "M-ANCHOR" })
    facts.push(fact("F3", {
      provenance: "request",
      evidenceSource: "log",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [{ kind: "system_order_no", value: "S-ONE" }],
      associationId: "A1",
    }), fact("F4", {
      provenance: "response",
      evidenceSource: "server",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [{ kind: "system_order_no", value: "S-TWO" }],
      associationId: "A1",
    }))

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        factIds: ["F1", "F2", "F3", "F4"],
        matchedIdentifiers: [{ kind: "merchant_order_no", value: "M-ANCHOR", factIds: ["F1", "F2"] }],
      })]),
      claims: [claim("F3", "request", "log")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("unconfirmed")
    expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([false, false, false, false])
    expect(result.issues.map((issue) => issue.code)).toContain("association_strong_identity_conflict")
    expect(result.strictReviewRequired).toBe(true)
  })

  it("keeps an association confirmed when repeated strong order identities agree", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "M-ANCHOR" })
    facts.push(fact("F3", {
      provenance: "request",
      evidenceSource: "log",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [{ kind: "system_order_no", value: "S-SAME" }],
      associationId: "A1",
      dependsOnFactIds: ["F1"],
    }), fact("F4", {
      provenance: "response",
      evidenceSource: "server",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [{ kind: "system_order_no", value: "S-SAME" }],
      associationId: "A1",
      dependsOnFactIds: ["F2"],
    }))

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        factIds: ["F1", "F2", "F3", "F4"],
        matchedIdentifiers: [{ kind: "merchant_order_no", value: "M-ANCHOR", factIds: ["F1", "F2"] }],
      })]),
      claims: [],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("confirmed")
    expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([true, true, true, true])
    expect(result.issues.map((issue) => issue.code)).not.toContain("association_strong_identity_conflict")
  })

  it("blocks a transaction inference that depends on facts from two transaction associations", () => {
    const evidencePacket = distinctConfirmedAssociations()
    evidencePacket.facts.push(fact("F5", {
      provenance: "inference",
      evidenceSource: "inference",
      certainty: "inferred",
      subjectKind: "transaction",
      businessType: "collection",
      associationId: "A1",
      dependsOnFactIds: ["F1", "F3"],
    }))
    evidencePacket.associations[0]!.factIds.push("F5")

    const result = applyEvidenceBindingGate({
      packet: evidencePacket,
      claims: [claim("F5", "inference")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations.map((item) => item.status)).toEqual(["confirmed", "confirmed"])
    expect(result.packet.facts.slice(0, 4).map((item) => item.outboundSafe)).toEqual([true, true, true, true])
    expect(result.packet.facts[4]?.outboundSafe).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("cross_association_transaction_dependency")
  })

  it("blocks an unassociated derived fact that combines multiple transaction associations", () => {
    const evidencePacket = distinctConfirmedAssociations()
    evidencePacket.facts.push(fact("F5", {
      provenance: "inference",
      evidenceSource: "inference",
      certainty: "inferred",
      dependsOnFactIds: ["F1", "F3"],
    }))

    const result = applyEvidenceBindingGate({
      packet: evidencePacket,
      claims: [claim("F5", "inference")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.facts[4]?.outboundSafe).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("cross_association_transaction_dependency")
  })

  it("allows same-association inference to depend on its anchor and a general code contract", () => {
    const evidencePacket = distinctConfirmedAssociations()
    evidencePacket.facts.push(
      fact("F5", {
        provenance: "inference",
        evidenceSource: "inference",
        certainty: "inferred",
        subjectKind: "transaction",
        businessType: "collection",
        associationId: "A1",
        dependsOnFactIds: ["F1", "F6"],
      }),
      fact("F6", {
        statement: "字段契约由当前代码确认",
        provenance: "code",
        evidenceSource: "code",
      }),
    )
    evidencePacket.associations[0]!.factIds.push("F5")

    const result = applyEvidenceBindingGate({
      packet: evidencePacket,
      claims: [claim("F5", "inference")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.facts.find((item) => item.id === "F5")?.outboundSafe).toBe(true)
    expect(result.issues.map((issue) => issue.code)).not.toContain("cross_association_transaction_dependency")
  })

  it("downgrades the whole association when an unrelated member carries another strong identity", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "MERCHANT-ONE" })
    facts.push(fact("F3", {
      provenance: "runtime",
      evidenceSource: "database",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [{ kind: "merchant_order_no", value: "MERCHANT-OTHER" }],
      associationId: "A1",
    }))
    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        factIds: ["F1", "F2", "F3"],
        matchedIdentifiers: [{
          kind: "merchant_order_no", value: "MERCHANT-ONE", factIds: ["F1", "F2"],
        }],
      })]),
      claims: [claim("F3")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("unconfirmed")
    expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([false, false, false])
    expect(result.issues.map((issue) => issue.code)).toContain("association_strong_identity_conflict")
  })

  it.each([
    ["code", "code"],
    ["document", "document"],
    ["recommendation", "message"],
  ] as const)("does not accept %s evidence as an exact transaction match endpoint", (provenance, evidenceSource) => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "MERCHANT-ONE" })
    facts[0] = {
      ...facts[0]!,
      provenance,
      evidenceSource,
      certainty: "confirmed",
    }

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        matchedIdentifiers: [{ kind: "merchant_order_no", value: "MERCHANT-ONE", factIds: ["F1", "F2"] }],
      })]),
      claims: [],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("unconfirmed")
    expect(result.packet.associations[0]?.matchedIdentifiers).toEqual([])
    expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([false, false])
    expect(result.issues.map((issue) => issue.code)).toContain("invalid_stable_identifier_match")
  })

  it("accepts actual request and response evidence as exact transaction match endpoints", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "MERCHANT-ONE" })
    facts[0] = { ...facts[0]!, provenance: "request", evidenceSource: "log", certainty: "confirmed" }
    facts[1] = { ...facts[1]!, provenance: "response", evidenceSource: "server", certainty: "confirmed" }

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        matchedIdentifiers: [{ kind: "merchant_order_no", value: "MERCHANT-ONE", factIds: ["F1", "F2"] }],
      })]),
      claims: [],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("confirmed")
    expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([true, true])
    expect(result.issues).toEqual([])
  })

  it("downgrades the association when a matched endpoint becomes unsafe through an inference dependency", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "M-1" })
    facts[1] = { ...facts[1]!, dependsOnFactIds: ["F4"] }
    facts.push(
      fact("F3", {
        provenance: "runtime",
        evidenceSource: "log",
        subjectKind: "transaction",
        businessType: "collection",
        associationId: "A1",
        dependsOnFactIds: ["F1"],
      }),
      fact("F4", {
        provenance: "inference",
        evidenceSource: "inference",
        certainty: "inferred",
        dependsOnFactIds: ["F1"],
      }),
    )

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        factIds: ["F1", "F2", "F3"],
        matchedIdentifiers: [{ kind: "merchant_order_no", value: "M-1", factIds: ["F1", "F2"] }],
      })]),
      claims: [claim("F3", "runtime", "log")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]).toMatchObject({ status: "unconfirmed", matchedIdentifiers: [] })
    expect(result.packet.facts.filter((item) => item.subjectKind === "transaction")
      .map((item) => [item.id, item.outboundSafe])).toEqual([
      ["F1", false],
      ["F2", false],
      ["F3", false],
    ])
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "confirmed_fact_depends_on_inference",
      "invalid_stable_identifier_match",
      "association_missing_stable_match",
      "claim_fact_not_outbound_safe",
    ]))
  })

  it("downgrades the association when a matched endpoint becomes unsafe through a memory dependency", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "M-1" })
    facts[1] = { ...facts[1]!, dependsOnFactIds: ["F4"] }
    facts.push(
      fact("F3", {
        provenance: "runtime",
        evidenceSource: "log",
        subjectKind: "transaction",
        businessType: "collection",
        associationId: "A1",
        dependsOnFactIds: ["F1"],
      }),
      fact("F4", { provenance: "recommendation", evidenceSource: "memory" }),
    )

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        factIds: ["F1", "F2", "F3"],
        matchedIdentifiers: [{ kind: "merchant_order_no", value: "M-1", factIds: ["F1", "F2"] }],
      })]),
      claims: [claim("F3", "runtime", "log")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]).toMatchObject({ status: "unconfirmed", matchedIdentifiers: [] })
    expect(result.packet.facts.filter((item) => item.subjectKind === "transaction")
      .map((item) => item.outboundSafe)).toEqual([false, false, false])
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "transaction_depends_on_memory_evidence",
      "invalid_stable_identifier_match",
      "association_missing_stable_match",
      "claim_fact_not_outbound_safe",
    ]))
  })

  it("keeps a trace-filtered unsafe endpoint from confirming an association", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "M-1" })
    facts[1] = { ...facts[1]!, outboundSafe: false }
    facts.push(fact("F3", {
      provenance: "runtime",
      evidenceSource: "log",
      subjectKind: "transaction",
      businessType: "collection",
      associationId: "A1",
      dependsOnFactIds: ["F1"],
    }))

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        factIds: ["F1", "F2", "F3"],
        matchedIdentifiers: [{ kind: "merchant_order_no", value: "M-1", factIds: ["F1", "F2"] }],
      })]),
      claims: [claim("F3", "runtime", "log")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]).toMatchObject({ status: "unconfirmed", matchedIdentifiers: [] })
    expect(result.packet.facts.filter((item) => item.subjectKind === "transaction")
      .map((item) => item.outboundSafe)).toEqual([false, false, false])
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "invalid_stable_identifier_match",
      "association_missing_stable_match",
      "claim_fact_not_outbound_safe",
    ]))
  })

  it("rejects a runtime/message fact that hitchhikes on an already confirmed transaction", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "MERCHANT-ONE" })
    facts.push(fact("F3", {
      provenance: "runtime",
      evidenceSource: "message",
      certainty: "confirmed",
      subjectKind: "transaction",
      businessType: "collection",
      associationId: "A1",
      dependsOnFactIds: ["F1"],
    }))

    expectStructuralErrorCode(() => applyEvidenceBindingGate({
      packet: packet(facts, [association({ factIds: ["F1", "F2", "F3"] })]),
      claims: [{
        factId: "F3",
        statement: "claim F3",
        provenance: "runtime",
        evidenceSource: "message",
        evidence: "evidence F3",
      }],
      responsibility: unknownResponsibility,
    }), "provenance_evidence_source_mismatch")
  })

  it("rejects claim metadata that pairs code provenance with database evidence", () => {
    expectStructuralErrorCode(() => applyEvidenceBindingGate({
      packet: packet([fact("F1")]),
      claims: [{
        factId: "F1",
        statement: "claim F1",
        provenance: "code",
        evidenceSource: "database",
        evidence: "evidence F1",
      }],
      responsibility: unknownResponsibility,
    }), "provenance_evidence_source_mismatch")
  })

  it("rejects claim provenance, source, or evidence that does not exactly match its fact", () => {
    expectStructuralErrorCode(() => applyEvidenceBindingGate({
      packet: packet([fact("F1")]),
      claims: [{
        factId: "F1",
        statement: "可以自然改写事实陈述",
        provenance: "recommendation",
        evidenceSource: "message",
        evidence: "用户说成功",
      }],
      responsibility: unknownResponsibility,
    }), "answer_claim_fact_metadata_mismatch")
  })

  it("accepts a naturally rephrased claim when source metadata exactly matches its fact", () => {
    const result = applyEvidenceBindingGate({
      packet: packet([fact("F1")]),
      claims: [{ ...claim("F1", "code"), statement: "自然改写后的事实" }],
      responsibility: unknownResponsibility,
    })

    expect(result.issues).toEqual([])
  })

  it.each([
    ["duplicate responsibility fact ids", ["F1", "F1"], "duplicate_responsibility_fact_reference"],
    ["unknown responsibility fact id", ["F24"], "unknown_responsibility_fact"],
  ] as const)("rejects %s", (_name, factIds, code) => {
    expectStructuralErrorCode(() => applyEvidenceBindingGate({
      packet: packet([fact("F1")]),
      claims: [],
      responsibility: {
        party: "our_side",
        certainty: "confirmed",
        evidenceSources: ["code", "database"],
        factIds: [...factIds],
      },
    }), code)
  })

  it.each([
    ["user_report", "message", "reported"],
    ["display", "message", "reported"],
    ["memory", "memory", "confirmed"],
    ["recommendation", "message", "confirmed"],
    ["inference", "inference", "inferred"],
  ] as const)(
    "marks responsibility source %s/%s as untrusted instead of preserving known responsibility",
    (provenance, evidenceSource, certainty) => {
      const result = applyEvidenceBindingGate({
        packet: packet([fact("F1", { provenance, evidenceSource, certainty })]),
        claims: [],
        responsibility: {
          party: "upstream",
          certainty: "inference",
          evidenceSources: [evidenceSource],
          factIds: ["F1"],
        },
      })

      expect(result.issues.map((issue) => issue.code)).toContain("responsibility_fact_source_not_allowed")
      expect(result.strictReviewRequired).toBe(true)
    },
  )

  it("rejects responsibility evidence sources that are duplicate or differ from directly cited facts", () => {
    expectStructuralErrorCode(() => applyEvidenceBindingGate({
      packet: packet([fact("F1")]),
      claims: [],
      responsibility: {
        party: "upstream",
        certainty: "inference",
        evidenceSources: ["code", "code"],
        factIds: ["F1"],
      },
    }), "duplicate_responsibility_evidence_source")
    expectStructuralErrorCode(() => applyEvidenceBindingGate({
      packet: packet([fact("F1")]),
      claims: [],
      responsibility: {
        party: "upstream",
        certainty: "inference",
        evidenceSources: ["database"],
        factIds: ["F1"],
      },
    }), "responsibility_evidence_source_mismatch")
  })

  it("accepts responsibility evidence sources as the order-independent set of directly cited facts", () => {
    const result = applyEvidenceBindingGate({
      packet: packet([
        fact("F1", { provenance: "runtime", evidenceSource: "database" }),
        fact("F2"),
      ]),
      claims: [],
      responsibility: {
        party: "our_side",
        certainty: "confirmed",
        evidenceSources: ["code", "database"],
        factIds: ["F1", "F2"],
      },
    })

    expect(result.issues).toEqual([])
  })

  it("marks responsibility unsafe when a cited fact transitively depends on recommendation memory", () => {
    const result = applyEvidenceBindingGate({
      packet: packet([
        fact("F1", { provenance: "recommendation", evidenceSource: "memory" }),
        fact("F2", { dependsOnFactIds: ["F1"] }),
        fact("F3", { provenance: "runtime", evidenceSource: "database" }),
      ]),
      claims: [],
      responsibility: {
        party: "our_side",
        certainty: "confirmed",
        evidenceSources: ["code", "database"],
        factIds: ["F2", "F3"],
      },
    })

    expect(result.issues.map((issue) => issue.code)).toContain("responsibility_fact_source_not_allowed")
  })

  it.each([
    ["user_report", "database", "runtime", "message"],
    ["display", "server", "callback", "message"],
  ] as const)(
    "rejects mismatched transaction provenance/source pairs %s+%s and %s+%s",
    (leftProvenance, leftSource, rightProvenance, rightSource) => {
      const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "MERCHANT-ONE" })
      facts[0] = {
        ...facts[0]!,
        provenance: leftProvenance,
        evidenceSource: leftSource,
        certainty: "confirmed",
      }
      facts[1] = {
        ...facts[1]!,
        provenance: rightProvenance,
        evidenceSource: rightSource,
        certainty: "confirmed",
      }

      expectStructuralErrorCode(() => applyEvidenceBindingGate({
        packet: packet(facts, [association({
          matchedIdentifiers: [{ kind: "merchant_order_no", value: "MERCHANT-ONE", factIds: ["F1", "F2"] }],
        })]),
        claims: [],
        responsibility: unknownResponsibility,
      }), "provenance_evidence_source_mismatch")
    },
  )

  it.each([
    ["user_report", "message", "runtime", "database"],
    ["request", "server", "response", "redis"],
  ] as const)(
    "accepts valid transaction provenance/source pairs %s+%s and %s+%s",
    (leftProvenance, leftSource, rightProvenance, rightSource) => {
      const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "MERCHANT-ONE" })
      facts[0] = {
        ...facts[0]!,
        provenance: leftProvenance,
        evidenceSource: leftSource,
        certainty: leftProvenance === "user_report" ? "reported" : "confirmed",
      }
      facts[1] = {
        ...facts[1]!,
        provenance: rightProvenance,
        evidenceSource: rightSource,
        certainty: "confirmed",
      }

      const result = applyEvidenceBindingGate({
        packet: packet(facts, [association({
          matchedIdentifiers: [{ kind: "merchant_order_no", value: "MERCHANT-ONE", factIds: ["F1", "F2"] }],
        })]),
        claims: [],
        responsibility: unknownResponsibility,
      })

      expect(result.packet.associations[0]?.status).toBe("confirmed")
      expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([true, true])
      expect(result.issues).toEqual([])
    },
  )

  it("does not accept a screenshot display fact as a stable transaction match endpoint", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "MERCHANT-ONE" })
    facts[0] = {
      ...facts[0]!,
      provenance: "display",
      evidenceSource: "message",
      certainty: "reported",
    }

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        matchedIdentifiers: [{ kind: "merchant_order_no", value: "MERCHANT-ONE", factIds: ["F1", "F2"] }],
      })]),
      claims: [],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("unconfirmed")
    expect(result.packet.associations[0]?.matchedIdentifiers).toEqual([])
    expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([false, false])
    expect(result.issues.map((issue) => issue.code)).toContain("invalid_stable_identifier_match")
  })

  it("blocks a no-identifier display fact from hitchhiking on an already confirmed transaction", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "MERCHANT-ONE" })
    facts.push(fact("F3", {
      provenance: "display",
      evidenceSource: "message",
      certainty: "reported",
      subjectKind: "transaction",
      businessType: "collection",
      identifiers: [],
      associationId: "A1",
      dependsOnFactIds: ["F1"],
    }))

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        factIds: ["F1", "F2", "F3"],
        matchedIdentifiers: [{
          kind: "merchant_order_no", value: "MERCHANT-ONE", factIds: ["F1", "F2"],
        }],
      })]),
      claims: [claim("F3", "display")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("confirmed")
    expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([true, true, false])
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "display_report_scope_invalid", "claim_fact_not_outbound_safe",
    ]))
  })

  it("blocks a transaction inference from indirectly attaching a general display report", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "MERCHANT-ONE" })
    facts.push(
      fact("F3", {
        provenance: "display",
        evidenceSource: "message",
        certainty: "reported",
      }),
      fact("F4", {
        provenance: "inference",
        evidenceSource: "inference",
        certainty: "inferred",
        subjectKind: "transaction",
        businessType: "collection",
        associationId: "A1",
        dependsOnFactIds: ["F1", "F3"],
      }),
    )

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        factIds: ["F1", "F2", "F4"],
        matchedIdentifiers: [{
          kind: "merchant_order_no", value: "MERCHANT-ONE", factIds: ["F1", "F2"],
        }],
      })]),
      claims: [claim("F4", "inference")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("confirmed")
    expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([true, true, true, false])
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "transaction_depends_on_display_report", "claim_fact_not_outbound_safe",
    ]))
  })

  it("blocks a transaction fact from directly or transitively depending on memory evidence", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "MERCHANT-ONE" })
    facts.push(
      fact("F3", { provenance: "recommendation", evidenceSource: "memory" }),
      fact("F4", {
        provenance: "inference",
        evidenceSource: "inference",
        certainty: "inferred",
        subjectKind: "transaction",
        businessType: "collection",
        associationId: "A1",
        dependsOnFactIds: ["F1", "F3"],
      }),
    )

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        factIds: ["F1", "F2", "F4"],
        matchedIdentifiers: [{
          kind: "merchant_order_no", value: "MERCHANT-ONE", factIds: ["F1", "F2"],
        }],
      })]),
      claims: [claim("F4", "inference")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.facts.map((item) => item.outboundSafe)).toEqual([true, true, true, false])
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "transaction_depends_on_memory_evidence", "claim_fact_not_outbound_safe",
    ]))
  })

  it("keeps an independent general memory recommendation outbound-safe", () => {
    const result = applyEvidenceBindingGate({
      packet: packet([fact("F1", { provenance: "recommendation", evidenceSource: "memory" })]),
      claims: [claim("F1", "recommendation", "memory")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.facts[0]?.outboundSafe).toBe(true)
    expect(result.issues.map((issue) => issue.code)).not.toContain("transaction_depends_on_memory_evidence")
  })

  it("blocks a confirmed fact whose dependency closure contains an inferred fact", () => {
    const result = applyEvidenceBindingGate({
      packet: packet([
        fact("F1", {
          provenance: "inference",
          evidenceSource: "inference",
          certainty: "inferred",
          dependsOnFactIds: ["F3"],
        }),
        fact("F2", { certainty: "confirmed", dependsOnFactIds: ["F1"] }),
        fact("F3"),
      ]),
      claims: [claim("F2", "code")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.facts.find((item) => item.id === "F2")?.outboundSafe).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "confirmed_fact_depends_on_inference", "claim_fact_not_outbound_safe",
    ]))
  })

  it("allows a confirmed fact to depend on a reported fact without promoting inference", () => {
    const result = applyEvidenceBindingGate({
      packet: packet([
        fact("F1", { provenance: "user_report", evidenceSource: "message", certainty: "reported" }),
        fact("F2", { certainty: "confirmed", dependsOnFactIds: ["F1"] }),
      ]),
      claims: [claim("F2", "code")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.facts.find((item) => item.id === "F2")?.outboundSafe).toBe(true)
    expect(result.issues.map((issue) => issue.code)).not.toContain("confirmed_fact_depends_on_inference")
  })

  it("downgrades matches that do not occur verbatim in two distinct trustworthy sources", () => {
    const facts = confirmedTransactionFacts({ kind: "merchant_order_no", value: "M-001" })
    facts[1] = {
      ...facts[1]!,
      identifiers: [{ kind: "merchant_order_no", value: "m-001" }],
    }

    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association()]),
      claims: [],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("unconfirmed")
    expect(result.packet.associations[0]?.matchedIdentifiers).toEqual([])
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "invalid_stable_identifier_match", "association_missing_stable_match",
    ]))
  })

  it.each([
    ["unknown association fact", (value: EvidencePacket) => { value.associations[0]!.factIds.push("F9") }],
    ["unknown matched fact", (value: EvidencePacket) => { value.associations[0]!.matchedIdentifiers[0]!.factIds[1] = "F9" }],
    ["unknown hint fact", (value: EvidencePacket) => {
      value.associations[0]!.lookupHints = [{ kind: "amount", value: "100", factIds: ["F9"] }]
    }],
    ["unknown conflict fact", (value: EvidencePacket) => {
      value.associations[0]!.conflicts = [{
        field: "channel", leftFactId: "F1", rightFactId: "F9", summary: "different",
      }]
    }],
    ["unknown fact association", (value: EvidencePacket) => { value.facts[0]!.associationId = "A9" }],
    ["unknown dependency", (value: EvidencePacket) => { value.facts[0]!.dependsOnFactIds = ["F9"] }],
  ] as const)("throws a structural error for %s references", (_name, mutate) => {
    const evidencePacket = packet(
      confirmedTransactionFacts({ kind: "merchant_order_no", value: "M-001" }),
      [association()],
    )
    mutate(evidencePacket)

    expectStructuralError(() => applyEvidenceBindingGate({
      packet: evidencePacket,
      claims: [],
      responsibility: unknownResponsibility,
    }))
  })

  it("throws a structural error for duplicate ids and inference dependency cycles", () => {
    const facts = [
      fact("F1", {
        provenance: "inference",
        evidenceSource: "inference",
        certainty: "inferred",
        dependsOnFactIds: ["F2"],
      }),
      fact("F2", {
        provenance: "inference",
        evidenceSource: "inference",
        certainty: "inferred",
        dependsOnFactIds: ["F1"],
      }),
    ]
    const duplicate = packet([facts[0]!, { ...facts[0]! }])

    expectStructuralError(() => applyEvidenceBindingGate({
      packet: duplicate,
      claims: [],
      responsibility: unknownResponsibility,
    }))
    expectStructuralError(() => applyEvidenceBindingGate({
      packet: packet(facts),
      claims: [],
      responsibility: unknownResponsibility,
    }))
  })

  it("throws a structural error when an answer claim cites an unknown fact", () => {
    expectStructuralError(() => applyEvidenceBindingGate({
      packet: packet([fact("F1")]),
      claims: [claim("F9")],
      responsibility: unknownResponsibility,
    }))
  })

  it("throws a structural error when a non-transaction fact carries a stable transaction identifier", () => {
    let caught: unknown
    try {
      applyEvidenceBindingGate({
        packet: packet([fact("F1", {
          subjectKind: "general",
          identifiers: [{ kind: "merchant_order_no", value: "M-NOT-GENERAL" }],
        })]),
        claims: [],
        responsibility: unknownResponsibility,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EvidenceBindingStructuralError)
    expect(caught).toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({
        code: "non_transaction_stable_identifier",
        factId: "F1",
      })]),
    })
  })

  it("throws a structural error when a general inference self-reports transaction association membership", () => {
    const evidencePacket = distinctConfirmedAssociations()
    evidencePacket.facts.push(fact("F5", {
      provenance: "inference",
      evidenceSource: "inference",
      certainty: "inferred",
      subjectKind: "general",
      businessType: "not_applicable",
      associationId: "A1",
      dependsOnFactIds: ["F1", "F3"],
    }))
    evidencePacket.associations[0]!.factIds.push("F5")

    let caught: unknown
    try {
      applyEvidenceBindingGate({
        packet: evidencePacket,
        claims: [claim("F5", "inference")],
        responsibility: unknownResponsibility,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EvidenceBindingStructuralError)
    expect(caught).toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({
        code: "non_transaction_association",
        factId: "F5",
        associationId: "A1",
      })]),
    })
  })

  it.each([
    ["association reverse membership", (value: EvidencePacket, claims: AnswerDecision["answerClaims"]) => {
      value.facts[1]!.associationId = null
      void claims
    }],
    ["duplicate matched fact", (value: EvidencePacket, claims: AnswerDecision["answerClaims"]) => {
      value.associations[0]!.matchedIdentifiers[0]!.factIds = ["F1", "F1"]
      void claims
    }],
    ["duplicate lookup fact", (value: EvidencePacket, claims: AnswerDecision["answerClaims"]) => {
      value.associations[0]!.lookupHints = [{ kind: "amount", value: "100", factIds: ["F1", "F1"] }]
      void claims
    }],
    ["self-referencing conflict", (value: EvidencePacket, claims: AnswerDecision["answerClaims"]) => {
      value.associations[0]!.conflicts = [{
        field: "channel", leftFactId: "F1", rightFactId: "F1", summary: "invalid self conflict",
      }]
      void claims
    }],
    ["duplicate answer claim", (_value: EvidencePacket, claims: AnswerDecision["answerClaims"]) => {
      claims.push(claim("F1"))
    }],
  ] as const)("throws a structural error for %s", (_name, mutate) => {
    const evidencePacket = packet(
      confirmedTransactionFacts({ kind: "merchant_order_no", value: "M-001" }),
      [association()],
    )
    const claims = [claim("F1")]
    mutate(evidencePacket, claims)

    expectStructuralError(() => applyEvidenceBindingGate({
      packet: evidencePacket,
      claims,
      responsibility: unknownResponsibility,
    }))
  })

  it("marks a stable identifier mapped to different system orders across associations as unconfirmed", () => {
    const facts = [
      fact("F1", {
        provenance: "user_report",
        evidenceSource: "message",
        certainty: "reported",
        subjectKind: "transaction",
        businessType: "collection",
        identifiers: [
          { kind: "merchant_order_no", value: "M-CROSS" },
          { kind: "system_order_no", value: "S-ONE" },
        ],
        associationId: "A1",
      }),
      fact("F2", {
        provenance: "runtime",
        evidenceSource: "database",
        subjectKind: "transaction",
        businessType: "collection",
        identifiers: [
          { kind: "merchant_order_no", value: "M-CROSS" },
          { kind: "system_order_no", value: "S-ONE" },
        ],
        associationId: "A1",
      }),
      fact("F3", {
        provenance: "user_report",
        evidenceSource: "message",
        certainty: "reported",
        subjectKind: "transaction",
        businessType: "collection",
        identifiers: [
          { kind: "merchant_order_no", value: "M-CROSS" },
          { kind: "system_order_no", value: "S-TWO" },
        ],
        associationId: "A2",
      }),
      fact("F4", {
        provenance: "runtime",
        evidenceSource: "log",
        subjectKind: "transaction",
        businessType: "collection",
        identifiers: [
          { kind: "merchant_order_no", value: "M-CROSS" },
          { kind: "system_order_no", value: "S-TWO" },
        ],
        associationId: "A2",
      }),
    ]
    const result = applyEvidenceBindingGate({
      packet: packet(facts, [
        association({
          matchedIdentifiers: [{
            kind: "merchant_order_no", value: "M-CROSS", factIds: ["F1", "F2"],
          }],
        }),
        association({
          id: "A2",
          factIds: ["F3", "F4"],
          matchedIdentifiers: [{
            kind: "merchant_order_no", value: "M-CROSS", factIds: ["F3", "F4"],
          }],
        }),
      ]),
      claims: [],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations.map((item) => item.status)).toEqual(["unconfirmed", "unconfirmed"])
    expect(result.issues.filter((issue) => issue.code === "stable_identifier_maps_multiple_orders")).toHaveLength(2)
  })

  it("propagates an unsafe unconfirmed transaction through transitive inference dependencies", () => {
    const facts = [
      fact("F1", {
        subjectKind: "transaction",
        businessType: "payment",
        associationId: "A1",
      }),
      fact("F2", {
        provenance: "inference",
        evidenceSource: "inference",
        certainty: "inferred",
        dependsOnFactIds: ["F1"],
      }),
      fact("F3", {
        provenance: "inference",
        evidenceSource: "inference",
        certainty: "inferred",
        dependsOnFactIds: ["F2"],
      }),
    ]
    const result = applyEvidenceBindingGate({
      packet: packet(facts, [association({
        factIds: ["F1"],
        status: "unconfirmed",
        matchedIdentifiers: [],
      })]),
      claims: [claim("F3", "inference")],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.facts.map((item) => [item.id, item.outboundSafe])).toEqual([
      ["F1", false],
      ["F2", false],
      ["F3", false],
    ])
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "dependent_fact_not_outbound_safe", "claim_fact_not_outbound_safe",
    ]))
  })

  it.each(["request", "response", "callback", "runtime"] as const)(
    "requires strict review when a claim cites %s evidence",
    (provenance) => {
      const source = provenance === "runtime" ? "database" : "log"
      const result = applyEvidenceBindingGate({
        packet: packet([fact("F1", { provenance, evidenceSource: source })]),
        claims: [claim("F1", provenance, source)],
        responsibility: unknownResponsibility,
      })

      expect(result.strictReviewRequired).toBe(true)
      expect(result.packet.reviewLevel).toBe("strict")
    },
  )

  it("requires strict review for an inference depending on runtime evidence", () => {
    const result = applyEvidenceBindingGate({
      packet: packet([
        fact("F1", { provenance: "runtime", evidenceSource: "database" }),
        fact("F2", {
          provenance: "inference",
          evidenceSource: "inference",
          certainty: "inferred",
          dependsOnFactIds: ["F1"],
        }),
      ]),
      claims: [claim("F2", "inference")],
      responsibility: unknownResponsibility,
    })

    expect(result.strictReviewRequired).toBe(true)
  })

  it("derives strict review from the cited fact instead of trusting claim metadata", () => {
    expectStructuralErrorCode(() => applyEvidenceBindingGate({
      packet: packet([fact("F1", { provenance: "runtime", evidenceSource: "database" })]),
      claims: [claim("F1", "user_report")],
      responsibility: unknownResponsibility,
    }), "answer_claim_fact_metadata_mismatch")
  })

  it("requires strict review for a non-unknown responsibility assessment", () => {
    const result = applyEvidenceBindingGate({
      packet: packet([fact("F1")]),
      claims: [],
      responsibility: {
        party: "merchant",
        certainty: "confirmed",
        evidenceSources: ["code"],
        factIds: ["F1"],
      },
    })

    expect(result.strictReviewRequired).toBe(true)
    expect(result.packet.reviewLevel).toBe("strict")
  })

  it("keeps an ordinary general answer on the non-strict path", () => {
    const result = applyEvidenceBindingGate({
      packet: packet([fact("F1")]),
      claims: [claim("F1", "code")],
      responsibility: unknownResponsibility,
    })

    expect(result.strictReviewRequired).toBe(false)
    expect(result.issues).toEqual([])
    expect(result.packet.facts[0]?.outboundSafe).toBe(true)
    expect(result.packet.reviewLevel).toBe("standard")
  })

  it("returns a trusted copy without mutating the model packet", () => {
    const evidencePacket = packet([
      fact("F1", {
        subjectKind: "transaction",
        businessType: "collection",
        associationId: "A1",
      }),
    ], [association({ factIds: ["F1"], matchedIdentifiers: [] })])

    const result = applyEvidenceBindingGate({
      packet: evidencePacket,
      claims: [],
      responsibility: unknownResponsibility,
    })

    expect(result.packet.associations[0]?.status).toBe("unconfirmed")
    expect(result.packet.facts[0]?.outboundSafe).toBe(false)
    expect(evidencePacket.associations[0]?.status).toBe("confirmed")
    expect(evidencePacket.facts[0]?.outboundSafe).toBe(true)
  })
})
