import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { NodeCommandRunner } from "../git-sync/command-runner.js"
import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import type { SupportAttachmentContext } from "../support/agent.js"

export type AttachmentKind = "text" | "image" | "video" | "archive" | "pdf" | "other"
export type IncomingAttachmentDescriptor = {
  name: string
  mimeType: string
  size: number
  kind: AttachmentKind
  download?: () => Promise<Buffer | null>
}

const limits: Record<AttachmentKind, number> = {
  text: 2 * 1024 * 1024,
  image: 10 * 1024 * 1024,
  video: 0,
  archive: 20 * 1024 * 1024,
  pdf: 15 * 1024 * 1024,
  other: 20 * 1024 * 1024,
}

export function attachmentKindFor(name: string, mimeType: string): AttachmentKind {
  const lower = name.toLocaleLowerCase("en-US")
  if (mimeType.startsWith("text/") || /\.(?:txt|log|json|xml|csv|md|yaml|yml)$/i.test(lower)) return "text"
  if (mimeType.startsWith("image/")) return "image"
  if (mimeType.startsWith("video/")) return "video"
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) return "pdf"
  if (/(?:zip|compressed|archive|tar|gzip|7z)/i.test(mimeType) || /\.(?:zip|tar|tgz|gz|7z|rar)$/i.test(lower)) return "archive"
  return "other"
}

function safeExtension(name: string): string {
  const extension = path.extname(name).toLocaleLowerCase("en-US")
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ""
}

export class AttachmentService {
  private readonly runner = new NodeCommandRunner()
  private readonly root: string

  constructor(dataDir: string, _redactor: ConfiguredSecretRedactor) {
    this.root = path.resolve(dataDir, "attachments")
  }

  describe(descriptor: IncomingAttachmentDescriptor): SupportAttachmentContext {
    const name = (descriptor.name || "未命名附件").slice(0, 240)
    const base: SupportAttachmentContext = {
      name, kind: descriptor.kind, mimeType: descriptor.mimeType.slice(0, 160), size: Math.max(0, descriptor.size),
      extractedText: "", localPath: null,
    }
    if (descriptor.kind === "video") return { ...base, extractedText: `视频附件：${name}，大小 ${descriptor.size} 字节；当前只读取元数据，不猜测视频内容。` }
    const limit = limits[descriptor.kind]
    if (!descriptor.download || limit === 0) return { ...base, extractedText: `附件：${name}；当前格式不读取正文。` }
    if (descriptor.size > limit) return { ...base, extractedText: `附件：${name}；文件超过 ${Math.floor(limit / 1024 / 1024)}MB，只记录元数据。` }
    return { ...base, extractedText: `${descriptor.kind === "image" ? "图片" : "附件"}：${name}；正在读取。` }
  }

  async prepare(descriptor: IncomingAttachmentDescriptor): Promise<SupportAttachmentContext> {
    const base = this.describe(descriptor)
    const name = base.name
    if (descriptor.kind === "video") return base
    const limit = limits[descriptor.kind]
    if (!descriptor.download || limit === 0 || descriptor.size > limit) return base
    const buffer = await descriptor.download()
    if (!buffer) return { ...base, extractedText: `附件：${name}；下载失败，只记录元数据。` }
    if (buffer.byteLength > limit) return { ...base, size: buffer.byteLength, extractedText: `附件：${name}；下载后发现文件过大，只记录元数据。` }
    const month = new Date().toISOString().slice(0, 7)
    const directory = path.join(this.root, month)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const filePath = path.join(directory, `${randomUUID()}${safeExtension(name)}`)
    await writeFile(filePath, buffer, { mode: 0o600 })
    return { ...base, size: buffer.byteLength, localPath: filePath, extractedText: await this.extract(descriptor.kind, filePath, buffer, name) }
  }

  async prepareBuffer(name: string, mimeType: string, buffer: Buffer): Promise<SupportAttachmentContext> {
    const safeName = (name || "未命名附件").slice(0, 240)
    const kind = attachmentKindFor(safeName, mimeType)
    if (buffer.byteLength > 20 * 1024 * 1024) throw new Error("单个附件不能超过 20MB")
    const month = new Date().toISOString().slice(0, 7)
    const directory = path.join(this.root, month)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const filePath = path.join(directory, `${randomUUID()}${safeExtension(safeName)}`)
    await writeFile(filePath, buffer, { mode: 0o600 })
    return {
      name: safeName,
      kind,
      mimeType: mimeType.slice(0, 160),
      size: buffer.byteLength,
      localPath: filePath,
      extractedText: kind === "video"
        ? `视频附件：${safeName}，大小 ${buffer.byteLength} 字节；当前只读取元数据，不猜测视频内容。`
        : await this.extract(kind, filePath, buffer, safeName),
    }
  }

  resolveStoredPath(filePath: string): string | null {
    if (!filePath) return null
    const candidate = path.resolve(filePath)
    const relative = path.relative(this.root, candidate)
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
    return candidate
  }

  private async extract(kind: AttachmentKind, filePath: string, buffer: Buffer, name: string): Promise<string> {
    if (kind === "text") {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).slice(0, 30_000)
        return text
      } catch {
        return `文本附件：${name}；不是有效 UTF-8，为避免乱码未读取正文。`
      }
    }
    if (kind === "image") return `图片附件：${name}；本机路径 ${filePath}`
    if (kind === "pdf") {
      try {
        const result = await this.runner.run("pdftotext", ["-layout", filePath, "-"], { cwd: path.dirname(filePath), timeoutMs: 20_000 })
        if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.slice(0, 30_000)
      } catch { /* 未安装解析器时仅记录元数据。 */ }
      return `PDF 附件：${name}；正文暂时无法解析。`
    }
    if (kind === "archive") {
      const extension = path.extname(name).toLocaleLowerCase("en-US")
      const command = extension === ".zip" ? ["unzip", ["-Z1", filePath]] as const : ["tar", ["-tf", filePath]] as const
      try {
        const result = await this.runner.run(command[0], [...command[1]], { cwd: path.dirname(filePath), timeoutMs: 15_000 })
        if (result.exitCode === 0) return `压缩包文件列表：\n${result.stdout.slice(0, 20_000)}`
      } catch { /* 只记录安全摘要。 */ }
      return `压缩包附件：${name}；无法安全读取文件列表。`
    }
    return `附件：${name}`
  }
}
