import type {
  AnswerClaim,
  EvidenceFact,
  EvidencePacket,
  ResponsibilityAssessment,
} from "../../src/codex/schemas.js"

export type TransactionEvidenceScenario = {
  id: string
  packet: EvidencePacket
  claims: AnswerClaim[]
  responsibility: ResponsibilityAssessment
  expected: {
    associationStatus: EvidencePacket["associations"][number]["status"]
    safeFactIds: string[]
    unsafeFactIds: string[]
    forbiddenClaimFactIds: string[]
    requiredIssueCodes: string[]
  }
}

const unknownResponsibility: ResponsibilityAssessment = {
  party: "unknown",
  certainty: "unknown",
  evidenceSources: [],
  factIds: [],
}

function fact(id: string, overrides: Partial<EvidenceFact>): EvidenceFact {
  return {
    id,
    statement: `Synthetic evidence fact ${id}`,
    provenance: "runtime",
    evidenceSource: "database",
    evidence: `Synthetic evidence excerpt ${id}`,
    certainty: "confirmed",
    outboundSafe: true,
    subjectKind: "transaction",
    businessType: "collection",
    identifiers: [],
    associationId: "A1",
    dependsOnFactIds: [],
    ...overrides,
  }
}

function claim(source: EvidenceFact): AnswerClaim {
  return {
    factId: source.id,
    statement: source.statement,
    provenance: source.provenance,
    evidenceSource: source.evidenceSource,
    evidence: source.evidence,
  }
}

function packet(overrides: Pick<EvidencePacket, "communication" | "facts" | "associations">
  & Partial<Pick<EvidencePacket, "requiredAnswerPoints" | "unknowns" | "handlingNotes" | "reviewLevel">>):
EvidencePacket {
  return {
    version: "2",
    requiredAnswerPoints: ["Preserve the declared transaction-association boundary"],
    unknowns: [],
    handlingNotes: ["Synthetic regression fixture; no production payload or attachment is included"],
    reviewLevel: "strict",
    ...overrides,
  }
}

const mismatchFacts = [
  fact("F1", {
    statement: "Synthetic user report identifies XDPay, collection, and amount 100",
    provenance: "user_report",
    evidenceSource: "message",
    evidence: "Synthetic user report: channel=XDPay; business=collection; amount=100; time=2099-01-01T00:00:00Z",
    certainty: "reported",
    businessType: "collection",
  }),
  fact("F2", {
    statement: "Synthetic candidate record identifies AOHPay, payment, amount 100, and a completed callback",
    evidence: "Synthetic database metadata: channel=AOHPay; business=payment; amount=100; time=2099-01-01T00:00:05Z",
    businessType: "payment",
    identifiers: [{ kind: "system_order_no", value: "SYN-SYSTEM-ORDER-0001" }],
  }),
  fact("F3", {
    statement: "The candidate would imply that channel configuration is effective",
    provenance: "inference",
    evidenceSource: "inference",
    evidence: "Derived only from synthetic candidate fact F2",
    certainty: "inferred",
    subjectKind: "configuration",
    businessType: "not_applicable",
    identifiers: [],
    associationId: null,
    dependsOnFactIds: ["F2"],
  }),
  fact("F4", {
    statement: "The candidate would imply that the caller page failed to parse a successful result",
    provenance: "inference",
    evidenceSource: "inference",
    evidence: "Derived only from synthetic candidate fact F2",
    certainty: "inferred",
    subjectKind: "general",
    businessType: "not_applicable",
    identifiers: [],
    associationId: null,
    dependsOnFactIds: ["F2"],
  }),
]

export const devaTransactionMismatchScenario: TransactionEvidenceScenario = {
  id: "synthetic-deva-channel-business-mismatch",
  packet: packet({
    communication: {
      intent: "minimal_clarification",
      recipient: null,
      desiredOutcome: "Obtain one stable identifier before using any candidate transaction fact",
    },
    facts: mismatchFacts,
    associations: [{
      id: "A1",
      subjectKind: "transaction",
      status: "confirmed",
      factIds: ["F1", "F2"],
      matchedIdentifiers: [],
      lookupHints: [
        { kind: "amount", value: "100", factIds: ["F1", "F2"] },
        { kind: "time", value: "2099-01-01T00:00Z", factIds: ["F1", "F2"] },
      ],
      conflicts: [
        { field: "business_type", leftFactId: "F1", rightFactId: "F2", summary: "Synthetic business types differ" },
        { field: "channel", leftFactId: "F1", rightFactId: "F2", summary: "Synthetic channel labels differ" },
      ],
    }],
    unknowns: ["No stable transaction identifier is shared by the display and candidate record"],
  }),
  claims: mismatchFacts.slice(1).map(claim),
  responsibility: unknownResponsibility,
  expected: {
    associationStatus: "conflicting",
    safeFactIds: [],
    unsafeFactIds: ["F1", "F2", "F3", "F4"],
    forbiddenClaimFactIds: ["F2", "F3", "F4"],
    requiredIssueCodes: [
      "association_business_type_conflict",
      "association_declared_conflict",
      "dependent_fact_not_outbound_safe",
      "claim_fact_not_outbound_safe",
    ],
  },
}

const sameHintsFacts = [
  fact("F1", {
    statement: "Synthetic user report has amount 240 and a nearby timestamp but no stable identifier",
    provenance: "user_report",
    evidenceSource: "message",
    evidence: "Synthetic user report hints: amount=240; time=2099-02-01T10:00:00Z",
    certainty: "reported",
  }),
  fact("F2", {
    statement: "Synthetic candidate has amount 240 and a nearby timestamp but no stable identifier",
    evidence: "Synthetic database hints: amount=240; time=2099-02-01T10:00:04Z",
  }),
]

export const sameAmountAndTimeWithoutIdentifierScenario: TransactionEvidenceScenario = {
  id: "same-amount-time-without-stable-id",
  packet: packet({
    communication: {
      intent: "minimal_clarification",
      recipient: null,
      desiredOutcome: "Request one stable identifier for current-service verification",
    },
    facts: sameHintsFacts,
    associations: [{
      id: "A1",
      subjectKind: "transaction",
      status: "confirmed",
      factIds: ["F1", "F2"],
      matchedIdentifiers: [],
      lookupHints: [
        { kind: "amount", value: "240", factIds: ["F1", "F2"] },
        { kind: "time", value: "2099-02-01T10:00Z", factIds: ["F1", "F2"] },
      ],
      conflicts: [],
    }],
    unknowns: ["A stable identifier is required to bind the candidate transaction"],
  }),
  claims: [claim(sameHintsFacts[1]!)],
  responsibility: unknownResponsibility,
  expected: {
    associationStatus: "unconfirmed",
    safeFactIds: [],
    unsafeFactIds: ["F1", "F2"],
    forbiddenClaimFactIds: ["F2"],
    requiredIssueCodes: ["association_missing_stable_match", "claim_fact_not_outbound_safe"],
  },
}

const stableIdentifierFacts = [
  fact("F1", {
    statement: "Synthetic user message contains a merchant order identifier",
    provenance: "user_report",
    evidenceSource: "message",
    evidence: "Synthetic merchant order identifier SYN-MERCHANT-ORDER-0002",
    certainty: "reported",
    identifiers: [{ kind: "merchant_order_no", value: "SYN-MERCHANT-ORDER-0002" }],
  }),
  fact("F2", {
    statement: "Synthetic current-service database record has the same merchant order identifier",
    evidence: "Synthetic database record for SYN-MERCHANT-ORDER-0002",
    identifiers: [{ kind: "merchant_order_no", value: "SYN-MERCHANT-ORDER-0002" }],
  }),
]

export const stableIdentifierPositiveScenario: TransactionEvidenceScenario = {
  id: "stable-merchant-order-positive-control",
  packet: packet({
    communication: {
      intent: "direct_answer",
      recipient: null,
      desiredOutcome: "Answer only the transaction bound by the exact stable identifier",
    },
    facts: stableIdentifierFacts,
    associations: [{
      id: "A1",
      subjectKind: "transaction",
      status: "confirmed",
      factIds: ["F1", "F2"],
      matchedIdentifiers: [{
        kind: "merchant_order_no",
        value: "SYN-MERCHANT-ORDER-0002",
        factIds: ["F1", "F2"],
      }],
      lookupHints: [],
      conflicts: [],
    }],
  }),
  claims: [claim(stableIdentifierFacts[1]!)],
  responsibility: unknownResponsibility,
  expected: {
    associationStatus: "confirmed",
    safeFactIds: ["F1", "F2"],
    unsafeFactIds: [],
    forbiddenClaimFactIds: [],
    requiredIssueCodes: [],
  },
}

const channelConflictFacts = [
  fact("F1", {
    statement: "Synthetic user message reports channel label Channel-Alpha and a merchant order identifier",
    provenance: "user_report",
    evidenceSource: "message",
    evidence: "Synthetic user message for SYN-MERCHANT-ORDER-0003; channel=Channel-Alpha",
    certainty: "reported",
    identifiers: [{ kind: "merchant_order_no", value: "SYN-MERCHANT-ORDER-0003" }],
  }),
  fact("F2", {
    statement: "Synthetic runtime fact has channel label Channel-Beta and the same merchant order identifier",
    evidence: "Synthetic database metadata for SYN-MERCHANT-ORDER-0003; channel=Channel-Beta",
    identifiers: [{ kind: "merchant_order_no", value: "SYN-MERCHANT-ORDER-0003" }],
  }),
]

export const sameIdentifierWithChannelConflictScenario: TransactionEvidenceScenario = {
  id: "same-stable-id-with-channel-conflict",
  packet: packet({
    communication: {
      intent: "minimal_clarification",
      recipient: null,
      desiredOutcome: "Preserve the unresolved channel conflict",
    },
    facts: channelConflictFacts,
    associations: [{
      id: "A1",
      subjectKind: "transaction",
      status: "confirmed",
      factIds: ["F1", "F2"],
      matchedIdentifiers: [{
        kind: "merchant_order_no",
        value: "SYN-MERCHANT-ORDER-0003",
        factIds: ["F1", "F2"],
      }],
      lookupHints: [
        { kind: "channel", value: "Channel-Alpha", factIds: ["F1"] },
        { kind: "channel", value: "Channel-Beta", factIds: ["F2"] },
      ],
      conflicts: [{
        field: "channel",
        leftFactId: "F1",
        rightFactId: "F2",
        summary: "Synthetic channel declarations conflict",
      }],
    }],
  }),
  claims: [claim(channelConflictFacts[1]!)],
  responsibility: unknownResponsibility,
  expected: {
    associationStatus: "conflicting",
    safeFactIds: [],
    unsafeFactIds: ["F1", "F2"],
    forbiddenClaimFactIds: ["F2"],
    requiredIssueCodes: ["association_declared_conflict", "claim_fact_not_outbound_safe"],
  },
}

const bankReferencePositiveFacts = [
  fact("F1", {
    statement: "Current synthetic code evidence defines result.bankReference as a bank transaction reference",
    provenance: "code",
    evidenceSource: "code",
    evidence: "Synthetic code contract establishes the field meaning",
    subjectKind: "general",
    businessType: "not_applicable",
    associationId: null,
  }),
  fact("F2", {
    statement: "Synthetic user message reports the defined bank transaction reference",
    provenance: "user_report",
    evidenceSource: "message",
    evidence: "Synthetic user message field bankReference=SYN-BANK-REFERENCE-0004",
    certainty: "reported",
    identifiers: [{ kind: "bank_reference", value: "SYN-BANK-REFERENCE-0004" }],
    dependsOnFactIds: ["F1"],
  }),
  fact("F3", {
    statement: "Synthetic runtime fact stores the same defined bank transaction reference",
    evidence: "Synthetic database field bankReference=SYN-BANK-REFERENCE-0004",
    identifiers: [{ kind: "bank_reference", value: "SYN-BANK-REFERENCE-0004" }],
    dependsOnFactIds: ["F1"],
  }),
]

export const bankReferenceWithEstablishedMeaningScenario: TransactionEvidenceScenario = {
  id: "bank-reference-with-established-field-meaning",
  packet: packet({
    communication: {
      intent: "direct_answer",
      recipient: null,
      desiredOutcome: "Use the bank reference after its field meaning and value are established",
    },
    facts: bankReferencePositiveFacts,
    associations: [{
      id: "A1",
      subjectKind: "transaction",
      status: "confirmed",
      factIds: ["F2", "F3"],
      matchedIdentifiers: [{
        kind: "bank_reference",
        value: "SYN-BANK-REFERENCE-0004",
        factIds: ["F2", "F3"],
      }],
      lookupHints: [],
      conflicts: [],
    }],
  }),
  claims: [claim(bankReferencePositiveFacts[2]!)],
  responsibility: unknownResponsibility,
  expected: {
    associationStatus: "confirmed",
    safeFactIds: ["F1", "F2", "F3"],
    unsafeFactIds: [],
    forbiddenClaimFactIds: [],
    requiredIssueCodes: [],
  },
}

const bankReferenceNegativeFacts = [
  fact("F1", {
    statement: "Synthetic user report contains an opaque reference-like field with no established meaning",
    provenance: "user_report",
    evidenceSource: "message",
    evidence: "Synthetic opaque field value SYN-OPAQUE-REFERENCE-0005",
    certainty: "reported",
    identifiers: [{ kind: "bank_reference", value: "SYN-OPAQUE-REFERENCE-0005" }],
  }),
  fact("F2", {
    statement: "Synthetic runtime record contains the same opaque value with no code evidence of its meaning",
    evidence: "Synthetic opaque runtime value SYN-OPAQUE-REFERENCE-0005",
    identifiers: [{ kind: "bank_reference", value: "SYN-OPAQUE-REFERENCE-0005" }],
  }),
]

export const bankReferenceWithoutEstablishedMeaningScenario: TransactionEvidenceScenario = {
  id: "reference-like-field-without-established-meaning",
  packet: packet({
    communication: {
      intent: "minimal_clarification",
      recipient: null,
      desiredOutcome: "Do not promote an opaque reference-like value to a stable identifier",
    },
    facts: bankReferenceNegativeFacts,
    associations: [{
      id: "A1",
      subjectKind: "transaction",
      status: "confirmed",
      factIds: ["F1", "F2"],
      matchedIdentifiers: [{
        kind: "bank_reference",
        value: "SYN-OPAQUE-REFERENCE-0005",
        factIds: ["F1", "F2"],
      }],
      lookupHints: [],
      conflicts: [],
    }],
    unknowns: ["The opaque field meaning is not established by current code or runtime evidence"],
  }),
  claims: [claim(bankReferenceNegativeFacts[1]!)],
  responsibility: unknownResponsibility,
  expected: {
    associationStatus: "unconfirmed",
    safeFactIds: [],
    unsafeFactIds: ["F1", "F2"],
    forbiddenClaimFactIds: ["F2"],
    requiredIssueCodes: [
      "bank_reference_meaning_not_established",
      "association_missing_stable_match",
      "claim_fact_not_outbound_safe",
    ],
  },
}

export const transactionEvidenceScenarios: TransactionEvidenceScenario[] = [
  devaTransactionMismatchScenario,
  sameAmountAndTimeWithoutIdentifierScenario,
  stableIdentifierPositiveScenario,
  sameIdentifierWithChannelConflictScenario,
  bankReferenceWithEstablishedMeaningScenario,
  bankReferenceWithoutEstablishedMeaningScenario,
]
