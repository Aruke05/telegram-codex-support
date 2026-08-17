import { randomUUID } from "node:crypto"

import { z } from "zod"

import type { RuntimeDatabase } from "../runtime/database.js"
import type { OperatorStyleVersion } from "../runtime/types.js"
import {
  baselineOperatorStyleProfile,
  operatorStyleProfileSchema,
  type OperatorStyleProfile,
} from "../support/operator-style.js"

type StyleSampleRow = {
  observation_id: string
  source_telegram_user_id: string
  thread_id: string
  safe_text: string
}

const observationIdsSchema = z.array(z.string().uuid()).min(1).max(500)
const allowedPhrases = ["就行", "这个", "发一下", "找对方看下"] as const

function characterCount(value: string): number {
  return Array.from(value).length
}

function roundedRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 100) / 100
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
}

function p90(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)]!
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function meaningfulSamples(samples: StyleSampleRow[]): StyleSampleRow[] {
  return samples.filter((sample) => sample.safe_text.trim().length > 0)
}

function sampleRatio(texts: string[], pattern: RegExp): number {
  return roundedRatio(texts.filter((text) => pattern.test(text)).length, texts.length)
}

export function aggregateOperatorStyleProfile(samples: StyleSampleRow[]): OperatorStyleProfile {
  samples = meaningfulSamples(samples)
  const texts = samples.map((sample) => sample.safe_text.trim())
  const textLengths = texts.map(characterCount)
  const lineGroups = texts.map((text) => text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean))
  const lineLengths = lineGroups.flat().map(characterCount)
  const segmentedCount = lineGroups.filter((lines) => lines.length > 1).length
  const singleCount = samples.length - segmentedCount
  const collaborativeRatio = sampleRatio(texts, /(?:我们|咱们|这边|先.{0,18}再)/u)
  const structuredActionRatio = sampleRatio(texts, /(?:^|\n)\s*(?:\d+[.、)]|[一二三四五六][.、)])/u)
  const contextualSofteningRatio = sampleRatio(texts, /(?:哈|呀|呢|啦|哥|姐)(?:[，。！？\s]|$)/u)
  const statistics = {
    sampleCount: samples.length,
    sourceUserCount: new Set(samples.map((sample) => sample.source_telegram_user_id)).size,
    threadCount: new Set(samples.map((sample) => sample.thread_id)).size,
    medianTextChars: median(textLengths),
    p90TextChars: p90(textLengths),
    singleMessageRatio: roundedRatio(singleCount, samples.length),
    segmentedMessageRatio: roundedRatio(segmentedCount, samples.length),
  }
  return operatorStyleProfileSchema.parse({
    serviceTone: baselineOperatorStyleProfile.serviceTone,
    languageRegister: baselineOperatorStyleProfile.languageRegister,
    ordinaryPunctuation: baselineOperatorStyleProfile.ordinaryPunctuation,
    interactionStyle: {
      collaboration: samples.length === 0 || collaborativeRatio >= 0.08
        ? "shared_problem_solving"
        : "direct_delivery",
      actionLayout: structuredActionRatio >= 0.25 ? "structured_when_requested" : "conversational",
      softening: samples.length === 0 || contextualSofteningRatio >= 0.08 ? "contextual" : "none",
    },
    statistics,
    shortSentenceMaxChars: clamp(p90(lineLengths), 8, 80),
    simpleReply: { maxMessages: 1, maxLines: clamp(median(lineGroups.map((lines) => lines.length)), 1, 2) },
    complexReply: { maxMessages: 3, maxLinesPerMessage: clamp(p90(lineGroups.map((lines) => lines.length)), 1, 3) },
    segmentation: statistics.segmentedMessageRatio > statistics.singleMessageRatio ? "line_break" : "single_message",
    allowedPhrases: allowedPhrases.filter((phrase) => texts.some((text) => text.includes(phrase))),
    forbiddenPhrases: baselineOperatorStyleProfile.forbiddenPhrases,
    clarification: baselineOperatorStyleProfile.clarification,
  })
}

export class OperatorStyleService {
  constructor(private readonly database: RuntimeDatabase) {}

  activeProfile(): OperatorStyleProfile {
    return this.database.readActiveOperatorStyle().profile
  }

  updateFromObservations(inputObservationIds: string[]): OperatorStyleVersion | null {
    const requestedIds = [...new Set(observationIdsSchema.parse(inputObservationIds))]
    return this.database.transaction(() => {
      const latest = this.database.readOperatorStyleVersions("ORDER BY version_number DESC LIMIT 1")[0] ?? null
      const existingEvidence = latest
        ? (this.database.prepare(`SELECT observation_id FROM operator_style_version_evidence
          WHERE operator_style_version_id=? AND observation_id IS NOT NULL ORDER BY observation_id`).all(latest.id) as Array<{ observation_id: string }>)
          .map((row) => row.observation_id)
        : []
      const combinedIds = [...new Set([...existingEvidence, ...requestedIds])]
      const placeholders = combinedIds.map(() => "?").join(",")
      const samples = meaningfulSamples(this.database.prepare(`SELECT
        observation.id AS observation_id,
        observation.source_telegram_user_id,
        observation.thread_id,
        event.safe_text
      FROM learning_source_observations observation
      JOIN support_message_events event ON event.id=observation.message_event_id
      JOIN telegram_roles role ON role.telegram_user_id=observation.source_telegram_user_id
      WHERE observation.id IN (${placeholders})
        AND observation.thread_id IS NOT NULL
        AND role.enabled=1
        AND role.learning_source_enabled=1
        AND role.role=observation.source_role
        AND event.sender_user_id=observation.source_telegram_user_id
      ORDER BY observation.created_at,observation.id`).all(...combinedIds) as StyleSampleRow[])
      if (samples.length === 0) return null

      const includedIds = new Set(samples.map((sample) => sample.observation_id))
      const hasNewEvidence = requestedIds.some((id) => includedIds.has(id) && !existingEvidence.includes(id))
      if (latest && !hasNewEvidence) return latest

      const profile = aggregateOperatorStyleProfile(samples)
      const status = profile.statistics.sampleCount >= 20
        && profile.statistics.sourceUserCount >= 2
        && profile.statistics.threadCount >= 5
        ? "active" as const
        : "candidate" as const
      const now = new Date().toISOString()
      if (status === "active") {
        this.database.prepare(`UPDATE operator_style_versions SET status='superseded',superseded_at=?
          WHERE status IN ('candidate','active')`).run(now)
      } else {
        this.database.prepare(`UPDATE operator_style_versions SET status='superseded',superseded_at=?
          WHERE status='candidate'`).run(now)
      }
      const version: OperatorStyleVersion = {
        id: randomUUID(),
        version: (latest?.version ?? 0) + 1,
        profile,
        status,
        sampleCount: profile.statistics.sampleCount,
        sourceUserCount: profile.statistics.sourceUserCount,
        threadCount: profile.statistics.threadCount,
        createdAt: now,
        activatedAt: status === "active" ? now : null,
        supersededAt: null,
      }
      this.database.insertOperatorStyleVersion(version)
      const insertEvidence = this.database.prepare(`INSERT INTO operator_style_version_evidence(
        id,operator_style_version_id,observation_id,source_telegram_user_id,thread_id
      ) VALUES (?,?,?,?,?)`)
      samples.forEach((sample) => insertEvidence.run(
        randomUUID(), version.id, sample.observation_id, sample.source_telegram_user_id, sample.thread_id,
      ))
      return version
    })
  }
}
