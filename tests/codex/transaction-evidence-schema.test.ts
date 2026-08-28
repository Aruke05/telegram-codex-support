import { describe, expect, it } from "vitest"

import {
  answerClaimSchema,
  answerDecisionJsonSchema,
  answerDecisionModelSchema,
  composedReplyJsonSchema,
  composedReplySchema,
  compatibleAnswerDecisionSchema,
  evidencePacketSchema,
  legacyAnswerClaimSchema,
  persistedEvidencePacketSchema,
  replyReviewSchema,
  responsibilityAssessmentSchema,
  type AnswerClaim,
} from "../../src/codex/schemas.js"

type AnswerClaimFactIdIsRequired = {} extends Pick<AnswerClaim, "factId"> ? false : true
const answerClaimFactIdIsRequired: AnswerClaimFactIdIsRequired = true

const baseDecision = {
  decision: "reply",
  escalationType: "none",
  humanOperation: null,
  answer: "已按订单号核对到这笔交易。",
  quote: null,
  reason: "消息和数据库中的商户订单号完全一致",
  confidence: 0.95,
  usedMemoryVersionIds: [],
  answerClaims: [{
    factId: "F2",
    statement: "已按订单号核对到这笔交易",
    provenance: "runtime",
    evidenceSource: "database",
    evidence: "merchant order M-001",
  }],
  responsibility: { party: "unknown", certainty: "unknown", evidenceSources: [], factIds: [] },
  interaction: {
    sentiment: "neutral",
    situation: "new_request",
    underlyingNeed: "核对一笔交易",
    responseStrategy: "direct_answer",
  },
  investigation: {
    summary: "按稳定订单标识核对",
    steps: [{
      source: "database",
      title: "查询当前服务订单",
      status: "confirmed",
      evidence: "merchant order M-001",
      conclusion: "数据库存在同一商户订单号",
    }],
  },
} as const

const v2Packet = {
  version: "2",
  communication: {
    intent: "direct_answer",
    recipient: null,
    desiredOutcome: "说明当前服务中的交易事实",
  },
  facts: [{
    id: "F1",
    statement: "运营提供的商户订单号为 M-001",
    provenance: "user_report",
    evidenceSource: "message",
    evidence: "M-001",
    certainty: "reported",
    outboundSafe: true,
    subjectKind: "transaction",
    businessType: "collection",
    identifiers: [{ kind: "merchant_order_no", value: "M-001" }],
    associationId: "A1",
    dependsOnFactIds: [],
  }, {
    id: "F2",
    statement: "当前服务订单 M-001 已创建",
    provenance: "runtime",
    evidenceSource: "database",
    evidence: "merchant order M-001",
    certainty: "confirmed",
    outboundSafe: true,
    subjectKind: "transaction",
    businessType: "collection",
    identifiers: [
      { kind: "merchant_order_no", value: "M-001" },
      { kind: "system_order_no", value: "001-ABC" },
      { kind: "upstream_order_no", value: "UP-001" },
      { kind: "bank_reference", value: "Rrn-001" },
      { kind: "request_id", value: "Req-001" },
    ],
    associationId: "A1",
    dependsOnFactIds: [],
  }],
  associations: [{
    id: "A1",
    subjectKind: "transaction",
    status: "confirmed",
    factIds: ["F1", "F2"],
    matchedIdentifiers: [{
      kind: "merchant_order_no",
      value: "M-001",
      factIds: ["F1", "F2"],
    }],
    lookupHints: [
      { kind: "amount", value: "100.00", factIds: ["F1", "F2"] },
      { kind: "time", value: "2026-08-27T01:15:00+08:00", factIds: ["F1"] },
      { kind: "recipient", value: "synthetic recipient", factIds: ["F1"] },
      { kind: "account", value: "masked account", factIds: ["F1"] },
      { kind: "merchant", value: "merchant-a", factIds: ["F1", "F2"] },
      { kind: "channel", value: "channel-a", factIds: ["F1", "F2"] },
    ],
    conflicts: [],
  }],
  requiredAnswerPoints: ["说明已按同一商户订单号核对"],
  unknowns: [],
  handlingNotes: ["不得扩大为其他交易"],
  reviewLevel: "strict",
} as const

describe("transaction evidence v2 schema", () => {
  it("keeps the generic AnswerClaim contract strict and isolates the legacy claim reader", () => {
    const legacyClaim = {
      statement: "旧版回答",
      provenance: "user_report",
      evidenceSource: "message",
      evidence: "旧版消息",
    }

    expect(answerClaimFactIdIsRequired).toBe(true)
    expect(answerClaimSchema.safeParse(legacyClaim).success).toBe(false)
    expect(legacyAnswerClaimSchema.safeParse(legacyClaim).success).toBe(true)
  })

  it("accepts a complete packet while preserving identifier spelling exactly", () => {
    const parsed = evidencePacketSchema.parse(v2Packet)

    expect(parsed.version).toBe("2")
    expect(parsed.facts[1]?.identifiers).toEqual([
      { kind: "merchant_order_no", value: "M-001" },
      { kind: "system_order_no", value: "001-ABC" },
      { kind: "upstream_order_no", value: "UP-001" },
      { kind: "bank_reference", value: "Rrn-001" },
      { kind: "request_id", value: "Req-001" },
    ])
    expect(parsed.associations[0]?.lookupHints.map((hint) => hint.kind)).toEqual([
      "amount", "time", "recipient", "account", "merchant", "channel",
    ])
  })

  it("models retrieved AI memory as an explicit paired evidence source", () => {
    const memoryDecision = {
      ...baseDecision,
      answer: "有效记忆要求对外沟通保留我方证据边界。",
      answerClaims: [{
        factId: "F1",
        statement: "有效记忆要求对外沟通保留我方证据边界",
        provenance: "memory",
        evidenceSource: "memory",
        evidence: "对外沟通需要提供我方证据",
      }],
      responsibility: { party: "not_applicable", certainty: "not_applicable", evidenceSources: [], factIds: [] },
      investigation: {
        summary: "读取本轮实际采用的有效记忆",
        steps: [{
          source: "memory",
          title: "读取有效记忆版本",
          status: "confirmed",
          evidence: "对外沟通需要提供我方证据",
          conclusion: "仅作为一般沟通规则使用",
        }],
      },
      evidencePacket: {
        ...v2Packet,
        facts: [{
          id: "F1",
          statement: "有效记忆要求对外沟通保留我方证据边界",
          provenance: "memory",
          evidenceSource: "memory",
          evidence: "对外沟通需要提供我方证据",
          certainty: "confirmed",
          outboundSafe: true,
          subjectKind: "general",
          businessType: "not_applicable",
          identifiers: [],
          associationId: null,
          dependsOnFactIds: [],
        }],
        associations: [],
      },
    }

    expect(answerDecisionModelSchema.safeParse(memoryDecision).success).toBe(true)
    expect(answerDecisionJsonSchema.properties.investigation.properties.steps.items
      .properties.source.enum).toContain("memory")
    expect(answerDecisionJsonSchema.properties.evidencePacket.properties.facts.items
      .properties.provenance.enum).toContain("memory")
  })

  it.each([
    ["memory", "document"],
    ["code", "memory"],
  ] as const)("rejects an unpaired memory fact provenance=%s source=%s", (provenance, evidenceSource) => {
    const packet = structuredClone(v2Packet)
    Object.assign(packet.facts[0]!, { provenance, evidenceSource })

    expect(evidencePacketSchema.safeParse(packet).success).toBe(false)
  })

  it.each([
    ["runtime", "message"],
    ["code", "database"],
  ] as const)("rejects an answer claim with mismatched provenance=%s source=%s", (provenance, evidenceSource) => {
    expect(answerClaimSchema.safeParse({
      ...baseDecision.answerClaims[0],
      provenance,
      evidenceSource,
    }).success).toBe(false)
  })

  it.each([
    ["runtime", "message"],
    ["code", "database"],
  ] as const)("rejects an evidence fact with mismatched provenance=%s source=%s", (provenance, evidenceSource) => {
    const packet = structuredClone(v2Packet)
    Object.assign(packet.facts[1]!, { provenance, evidenceSource })

    expect(evidencePacketSchema.safeParse(packet).success).toBe(false)
  })

  it.each([
    ["user_report", "message"],
    ["display", "message"],
    ["request", "server"],
    ["response", "log"],
    ["callback", "database"],
    ["runtime", "redis"],
    ["memory", "memory"],
    ["code", "code"],
    ["document", "document"],
    ["inference", "inference"],
    ["recommendation", "message"],
    ["recommendation", "memory"],
    ["recommendation", "database"],
  ] as const)("accepts the provenance/source pair %s+%s", (provenance, evidenceSource) => {
    expect(answerClaimSchema.safeParse({
      ...baseDecision.answerClaims[0],
      provenance,
      evidenceSource,
    }).success).toBe(true)
  })

  it("allows a general recommendation to cite memory but keeps memory transaction limits", () => {
    const generalRecommendationFact = structuredClone(v2Packet.facts[0])
    Object.assign(generalRecommendationFact, {
      provenance: "recommendation",
      evidenceSource: "memory",
      certainty: "confirmed",
      subjectKind: "general",
      businessType: "not_applicable",
      identifiers: [],
      associationId: null,
    })
    const generalRecommendation = {
      ...structuredClone(v2Packet),
      facts: [generalRecommendationFact],
      associations: [],
    }

    const transactionRecommendation = structuredClone(v2Packet)
    Object.assign(transactionRecommendation.facts[0]!, {
      provenance: "recommendation",
      evidenceSource: "memory",
      certainty: "confirmed",
    })

    expect(evidencePacketSchema.safeParse(generalRecommendation).success).toBe(true)
    expect(evidencePacketSchema.safeParse(transactionRecommendation).success).toBe(false)
  })

  it("rejects a user report promoted from reported to confirmed", () => {
    const packet = structuredClone(v2Packet)
    Object.assign(packet.facts[0]!, { certainty: "confirmed" })

    expect(evidencePacketSchema.safeParse(packet).success).toBe(false)
  })

  it("requires explicit unique fact references for known responsibility assessments", () => {
    expect(responsibilityAssessmentSchema.safeParse({
      party: "our_side",
      certainty: "confirmed",
      evidenceSources: ["code", "database"],
      factIds: ["F1", "F2"],
    }).success).toBe(true)
    expect(responsibilityAssessmentSchema.safeParse({
      party: "merchant",
      certainty: "inference",
      evidenceSources: ["message"],
      factIds: [],
    }).success).toBe(false)
    expect(responsibilityAssessmentSchema.safeParse({
      party: "upstream",
      certainty: "confirmed",
      evidenceSources: ["code", "database"],
      factIds: ["F1", "F1"],
    }).success).toBe(false)
  })

  it.each(["unknown", "not_applicable"] as const)(
    "requires %s responsibility to carry neither fact references nor evidence sources",
    (party) => {
      expect(responsibilityAssessmentSchema.safeParse({
        party,
        certainty: party,
        evidenceSources: [],
        factIds: ["F1"],
      }).success).toBe(false)
      expect(responsibilityAssessmentSchema.safeParse({
        party,
        certainty: party,
        evidenceSources: ["message"],
        factIds: [],
      }).success).toBe(false)
    },
  )

  it("requires responsibility evidence sources to be unique", () => {
    expect(responsibilityAssessmentSchema.safeParse({
      party: "our_side",
      certainty: "confirmed",
      evidenceSources: ["code", "code"],
      factIds: ["F1"],
    }).success).toBe(false)
  })

  it.each([
    ["merchant", "unknown"],
    ["upstream", "not_applicable"],
    ["unknown", "not_applicable"],
    ["not_applicable", "unknown"],
  ] as const)("rejects responsibility state mismatch party=%s certainty=%s", (party, certainty) => {
    expect(responsibilityAssessmentSchema.safeParse({
      party,
      certainty,
      evidenceSources: [],
      factIds: [],
    }).success).toBe(false)
  })

  it.each([
    ["our_side", "confirmed", ["F1"]],
    ["merchant", "inference", ["F1"]],
    ["unknown", "unknown", []],
    ["not_applicable", "not_applicable", []],
  ] as const)("accepts responsibility state party=%s certainty=%s", (party, certainty, factIds) => {
    expect(responsibilityAssessmentSchema.safeParse({
      party,
      certainty,
      evidenceSources: ["confirmed", "inference"].includes(certainty) ? ["code"] : [],
      factIds: [...factIds],
    }).success).toBe(true)
  })

  it.each([
    [["memory"]],
    [["memory", "database"]],
  ])("does not accept memory as confirmed current responsibility evidence: %j", (evidenceSources) => {
    expect(responsibilityAssessmentSchema.safeParse({
      party: "upstream",
      certainty: "confirmed",
      evidenceSources,
      factIds: ["F1"],
    }).success).toBe(false)
  })

  it("does not accept memory as evidence for an inferred known responsibility", () => {
    expect(responsibilityAssessmentSchema.safeParse({
      party: "upstream",
      certainty: "inference",
      evidenceSources: ["memory"],
      factIds: ["F1"],
    }).success).toBe(false)
  })

  it("does not allow memory to represent a current transaction fact or stable identifier", () => {
    const packet = structuredClone(v2Packet)
    Object.assign(packet.facts[0]!, {
      provenance: "memory",
      evidenceSource: "memory",
      certainty: "confirmed",
    })

    expect(evidencePacketSchema.safeParse(packet).success).toBe(false)
  })

  it("allows only a detached general reported display fact", () => {
    const positiveFact = structuredClone(v2Packet.facts[0])
    Object.assign(positiveFact, {
      provenance: "display",
      evidenceSource: "message",
      certainty: "reported",
      subjectKind: "general",
      businessType: "not_applicable",
      identifiers: [],
      associationId: null,
      dependsOnFactIds: [],
    })
    const positive = {
      ...structuredClone(v2Packet),
      facts: [positiveFact],
      associations: [],
    }

    const hitchhiking = structuredClone(v2Packet)
    Object.assign(hitchhiking.facts[0]!, {
      provenance: "display",
      evidenceSource: "message",
      certainty: "reported",
      dependsOnFactIds: ["F2"],
    })

    expect(evidencePacketSchema.safeParse(positive).success).toBe(true)
    expect(evidencePacketSchema.safeParse(hitchhiking).success).toBe(false)
  })

  it("rejects every non-transaction fact that claims transaction association membership", () => {
    const associatedGeneralFact = structuredClone(v2Packet)
    Object.assign(associatedGeneralFact.facts[0]!, {
      subjectKind: "general",
      businessType: "not_applicable",
      identifiers: [],
      associationId: "A1",
    })

    expect(evidencePacketSchema.safeParse(associatedGeneralFact).success).toBe(false)
  })

  it("rejects inferred facts without an explicit dependency", () => {
    const packet = {
      ...v2Packet,
      facts: [v2Packet.facts[0], {
        ...v2Packet.facts[1],
        provenance: "inference" as const,
        evidenceSource: "inference" as const,
        certainty: "inferred" as const,
        dependsOnFactIds: [],
      }],
    }

    expect(evidencePacketSchema.safeParse(packet).success).toBe(false)
  })

  it("rejects an inferred certainty disguised with runtime and database provenance", () => {
    const packet = structuredClone(v2Packet)
    Object.assign(packet.facts[1]!, {
      certainty: "inferred",
      dependsOnFactIds: ["F1"],
    })

    expect(evidencePacketSchema.safeParse(packet).success).toBe(false)
  })

  it("rejects duplicate association ids before the binding gate", () => {
    const packet = {
      ...v2Packet,
      associations: [v2Packet.associations[0], { ...v2Packet.associations[0] }],
    }

    expect(evidencePacketSchema.safeParse(packet).success).toBe(false)
  })

  it("requires A1 through A24 association ids", () => {
    const packet = {
      ...v2Packet,
      facts: v2Packet.facts.map((fact) => ({ ...fact, associationId: "association-1" })),
      associations: [{ ...v2Packet.associations[0], id: "association-1" }],
    }

    expect(evidencePacketSchema.safeParse(packet).success).toBe(false)
  })

  it("reads persisted v1 without upgrading it into a sendable v2 decision", () => {
    const { factIds: _responsibilityFactIds, ...legacyResponsibility } = baseDecision.responsibility
    const legacyDecision = {
      ...baseDecision,
      responsibility: legacyResponsibility,
      answerClaims: baseDecision.answerClaims.map(({ factId: _factId, ...claim }) => claim),
      evidencePacket: {
        version: "1",
        communication: v2Packet.communication,
        facts: v2Packet.facts.map((fact) => {
          const {
            subjectKind: _subjectKind,
            businessType: _businessType,
            identifiers: _identifiers,
            associationId: _associationId,
            dependsOnFactIds: _dependsOnFactIds,
            ...legacyFact
          } = fact
          return legacyFact
        }),
        requiredAnswerPoints: v2Packet.requiredAnswerPoints,
        unknowns: v2Packet.unknowns,
        handlingNotes: v2Packet.handlingNotes,
        reviewLevel: v2Packet.reviewLevel,
      },
    }

    const stored = persistedEvidencePacketSchema.parse(legacyDecision.evidencePacket)
    const compatibleDecision = compatibleAnswerDecisionSchema.parse(legacyDecision)

    expect(stored.version).toBe("1")
    expect(compatibleDecision.evidencePacket?.version).toBe("1")
    expect(compatibleDecision.evidencePacket).not.toHaveProperty("associations")
    expect(answerDecisionModelSchema.safeParse(legacyDecision).success).toBe(false)
  })

  it("requires v2 packet fields and fact ids in the live model contract", () => {
    const decision = { ...baseDecision, evidencePacket: v2Packet }

    expect(answerDecisionModelSchema.parse(decision).evidencePacket.version).toBe("2")

    const packetSchema = answerDecisionJsonSchema.properties.evidencePacket
    const claimSchema = answerDecisionJsonSchema.properties.answerClaims.items
    expect(packetSchema.required).toContain("associations")
    expect(packetSchema.properties.version.enum).toEqual(["2"])
    expect(packetSchema.properties.facts.items.required).toEqual(expect.arrayContaining([
      "subjectKind", "businessType", "identifiers", "associationId", "dependsOnFactIds",
    ]))
    expect(claimSchema.required).toContain("factId")
    expect(answerDecisionJsonSchema.properties.responsibility.required).toContain("factIds")
    const matchedFactIds = packetSchema.properties.associations.items.properties.matchedIdentifiers
      .items.properties.factIds
    expect(matchedFactIds).not.toHaveProperty("prefixItems")
    expect(matchedFactIds.items).toMatchObject({ type: "string" })
  })

  it("rejects a non-ignore answer without any answer claim", () => {
    const decision = {
      ...baseDecision,
      answerClaims: [],
      evidencePacket: v2Packet,
    }

    const parsed = answerDecisionModelSchema.safeParse(decision)

    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["answerClaims"] }),
    ]))
  })

  it("rejects a non-ignore answer without any evidence fact", () => {
    const decision = {
      ...baseDecision,
      evidencePacket: { ...v2Packet, facts: [] },
    }

    const parsed = answerDecisionModelSchema.safeParse(decision)

    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["evidencePacket", "facts"] }),
    ]))
  })

  it("rejects an answer claim whose statement is absent from the answer", () => {
    const decision = {
      ...baseDecision,
      answerClaims: [{
        ...baseDecision.answerClaims[0],
        statement: "数据库记录显示订单已经成功",
      }],
      evidencePacket: v2Packet,
    }

    const parsed = answerDecisionModelSchema.safeParse(decision)

    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["answerClaims", 0, "statement"] }),
    ]))
  })

  it("allows ignore decisions to omit claims and facts", () => {
    const decision = {
      ...baseDecision,
      decision: "ignore" as const,
      answer: "",
      answerClaims: [],
      evidencePacket: {
        ...v2Packet,
        communication: { ...v2Packet.communication, intent: "ignore" as const },
        facts: [],
        associations: [],
        requiredAnswerPoints: [],
      },
    }

    expect(answerDecisionModelSchema.safeParse(decision).success).toBe(true)
  })

  it("requires every non-ignore composed reply to carry at least one fact claim", () => {
    const parsed = composedReplySchema.safeParse({
      answer: "请补充准确订单号",
      quote: null,
      claims: [],
      usedMemoryVersionIds: [],
    })

    expect(parsed.success).toBe(false)
    expect(composedReplyJsonSchema.properties.claims.minItems).toBe(1)
  })

  it.each([
    ["approve", ["仍存在明确问题"]],
    ["revise", []],
    ["prefer_baseline", []],
  ] as const)("rejects contradictory review output %s with issues=%j", (outcome, issues) => {
    expect(replyReviewSchema.safeParse({ outcome, issues, reason: "审核结论" }).success).toBe(false)
  })

  it.each([
    ["approve", []],
    ["revise", ["需要补充边界"]],
    ["prefer_baseline", ["候选弱于基线"]],
  ] as const)("accepts consistent review output %s with issues=%j", (outcome, issues) => {
    expect(replyReviewSchema.safeParse({ outcome, issues, reason: "审核结论" }).success).toBe(true)
  })
})
