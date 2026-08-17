import { describe, expect, it } from "vitest"

import { StaticMagicBookKnowledgeSource } from "../../src/magicbook/json-source.js"
import { MagicBookRepository } from "../../src/magicbook/repository.js"
import type { MagicBookSource } from "../../src/magicbook/types.js"

async function initialSnapshot() {
  return new StaticMagicBookKnowledgeSource(
    "config/magicbook-safe-bootstrap.json",
    "knowledge/bootstrap/magicbook-bank-codes-sanitized.json",
  ).load()
}

describe("MagicBookRepository", () => {
  it("人工导入失败时保留上一份安全快照", async () => {
    const initial = await initialSnapshot()
    const repository = new MagicBookRepository(initial)
    const failingSource: MagicBookSource = {
      load: async () => {
        throw new Error("raw secret should not escape")
      },
    }

    const result = await repository.importSnapshot(failingSource)

    expect(result).toEqual({ updated: false, error: "MagicBook 导入失败" })
    expect(repository.current()).toEqual(initial)
    expect(JSON.stringify(result)).not.toContain("raw secret")
  })

  it("人工导入成功后原子替换当前快照", async () => {
    const initial = await initialSnapshot()
    const repository = new MagicBookRepository(initial)
    const next = structuredClone(initial)
    next.sourceVersion = "next-version"
    const source: MagicBookSource = { load: async () => next }

    const result = await repository.importSnapshot(source)

    expect(result).toEqual({ updated: true, sourceVersion: "next-version", contentHash: next.contentHash })
    expect(repository.current().sourceVersion).toBe("next-version")
  })

  it("调用方修改返回值不会污染仓库", async () => {
    const repository = new MagicBookRepository(await initialSnapshot())
    const current = repository.current()

    current.parameters.splice(0)

    expect(repository.current().parameters).toHaveLength(5)
  })
})
