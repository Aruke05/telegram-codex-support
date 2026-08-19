import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { EncryptedValue } from "./types.js"

const algorithm = "aes-256-gcm"

export class LocalSecretVault {
  private constructor(private readonly key: Buffer) {}

  static async open(keyPath: string): Promise<LocalSecretVault> {
    await mkdir(path.dirname(keyPath), { recursive: true })
    let key: Buffer
    try {
      key = await readFile(keyPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const candidate = randomBytes(32)
      try {
        await writeFile(keyPath, candidate, { flag: "wx", mode: 0o600 })
        key = candidate
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError
        key = await readFile(keyPath)
      }
    }
    if (key.length !== 32) throw new Error("本机主密钥格式错误")
    return new LocalSecretVault(key)
  }

  sealText(value: string): EncryptedValue {
    const iv = randomBytes(12)
    const cipher = createCipheriv(algorithm, this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
    return {
      algorithm,
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }
  }

  openText(value: EncryptedValue): string {
    try {
      const decipher = createDecipheriv(algorithm, this.key, Buffer.from(value.iv, "base64"))
      decipher.setAuthTag(Buffer.from(value.authTag, "base64"))
      return Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8")
    } catch {
      throw new Error("本机敏感配置无法解密")
    }
  }

  sealJson(value: unknown): EncryptedValue {
    return this.sealText(JSON.stringify(value))
  }

  openJson<T>(value: EncryptedValue): T {
    try {
      return JSON.parse(this.openText(value)) as T
    } catch (error) {
      if (error instanceof Error && error.message === "本机敏感配置无法解密") throw error
      throw new Error("本机敏感配置格式错误")
    }
  }

  mac(scope: string, value: string): Buffer {
    return createHmac("sha256", this.key).update(scope, "utf8").update("\0", "utf8").update(value, "utf8").digest()
  }
}
