import { lstat, readdir, realpath } from "node:fs/promises"
import { lstatSync, readdirSync, realpathSync } from "node:fs"
import path from "node:path"

const identifierPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu

export function assertSafeCodeIdentifier(value: string): void {
  if (!identifierPattern.test(value)) throw new Error("服务代码目录标识无效")
}

export function pathInside(candidate: string, root: string, allowSame = false): boolean {
  const relative = path.relative(root, candidate)
  if (relative === "") return allowSame
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export async function assertNoSymlinkDirectoryPath(root: string, candidate: string): Promise<void> {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  if (!pathInside(resolvedCandidate, resolvedRoot, true)) throw new Error("服务代码目录越界")
  const rootStat = await lstat(resolvedRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("服务代码根目录无效")
  const realRoot = await realpath(resolvedRoot)
  const relative = path.relative(resolvedRoot, resolvedCandidate)
  let current = resolvedRoot
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("服务代码目录包含符号链接或非目录节点")
      const realCurrent = await realpath(current)
      if (!pathInside(realCurrent, realRoot, true)) throw new Error("服务代码真实目录越界")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }
}

export function isExistingSafeDirectoryPath(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  if (!pathInside(resolvedCandidate, resolvedRoot, true)) return false
  try {
    const rootStat = lstatSync(resolvedRoot)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false
    const realRoot = realpathSync(resolvedRoot)
    const relative = path.relative(resolvedRoot, resolvedCandidate)
    let current = resolvedRoot
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false
      if (!pathInside(realpathSync(current), realRoot, true)) return false
    }
    return true
  } catch {
    return false
  }
}

export async function assertTreeHasNoSymlinks(root: string): Promise<void> {
  await assertNoSymlinkDirectoryPath(root, root)
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("代码快照包含符号链接")
    if (entry.isDirectory()) await assertTreeHasNoSymlinks(path.join(root, entry.name))
  }
}

export function isExistingTreeWithoutSymlinks(root: string): boolean {
  if (!isExistingSafeDirectoryPath(root, root)) return false
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return false
      if (entry.isDirectory() && !isExistingTreeWithoutSymlinks(path.join(root, entry.name))) return false
    }
    return true
  } catch {
    return false
  }
}
