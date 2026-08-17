import { validateSafeMagicBookSnapshot } from "./json-source.js"
import type { MagicBookSource, SafeMagicBookSnapshot } from "./types.js"

export type MagicBookRefreshResult =
  | { updated: true; sourceVersion: string; contentHash: string }
  | { updated: false; error: "MagicBook 导入失败" }

export class MagicBookRepository {
  private snapshot: SafeMagicBookSnapshot

  constructor(snapshot: SafeMagicBookSnapshot) {
    this.snapshot = validateSafeMagicBookSnapshot(snapshot)
  }

  current(): SafeMagicBookSnapshot {
    return structuredClone(this.snapshot)
  }

  async importSnapshot(source: MagicBookSource): Promise<MagicBookRefreshResult> {
    try {
      const next = validateSafeMagicBookSnapshot(await source.load())
      this.snapshot = next
      return { updated: true, sourceVersion: next.sourceVersion, contentHash: next.contentHash }
    } catch {
      return { updated: false, error: "MagicBook 导入失败" }
    }
  }
}
