import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const serverBuildManifestName = ".reply-regression-build-manifest.json"

const manifestVersion = 1
const fixedBuildInputs = [
  "package.json",
  "pnpm-lock.yaml",
  "scripts/build-server.mjs",
  "scripts/run-reply-regression.mjs",
  "tsconfig.build.json",
  "tsconfig.json",
]

function relativePosix(rootDirectory, filePath) {
  return path.relative(rootDirectory, filePath).split(path.sep).join("/")
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function expectedOutputForSource(sourcePath) {
  return `dist/${sourcePath.slice("src/".length).replace(/\.ts$/u, ".js")}`
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function canonicalDirectory(directory) {
  const resolved = path.resolve(directory)
  const value = await lstat(resolved)
  if (value.isSymbolicLink() || !value.isDirectory()) throw new Error("服务端构建路径不安全")
  return realpath(resolved)
}

async function collectRegularFiles(rootDirectory, options) {
  const root = await canonicalDirectory(rootDirectory)
  const pending = [root]
  const files = []
  while (pending.length > 0) {
    const current = pending.pop()
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      const relative = relativePosix(root, entryPath)
      const value = await lstat(entryPath)
      if (value.isSymbolicLink()) throw new Error("服务端构建清单不允许符号链接")
      if (value.isDirectory()) {
        if (!options.skipDirectory?.(relative)) pending.push(entryPath)
        continue
      }
      if (!value.isFile()) throw new Error("服务端构建清单只允许普通文件")
      if (options.include(relative)) files.push(entryPath)
    }
  }
  return files.sort((left, right) => compareText(relativePosix(root, left), relativePosix(root, right)))
}

async function regularFileRecord(rootDirectory, relativePath) {
  const filePath = path.join(rootDirectory, ...relativePath.split("/"))
  const value = await lstat(filePath)
  if (value.isSymbolicLink() || !value.isFile()) throw new Error("服务端构建清单输入不安全")
  return {
    path: relativePath,
    sha256: createHash("sha256").update(await readFile(filePath)).digest("hex"),
  }
}

async function sourceInputPaths(rootDirectory) {
  const sourceRoot = path.join(rootDirectory, "src")
  const sourceFiles = await collectRegularFiles(sourceRoot, {
    include: (relative) => relative.endsWith(".ts"),
  })
  return sourceFiles.map((filePath) => `src/${relativePosix(sourceRoot, filePath)}`)
}

async function buildInputRecords(rootDirectory) {
  const inputPaths = [...fixedBuildInputs, ...await sourceInputPaths(rootDirectory)].sort()
  return Promise.all(inputPaths.map((relativePath) => regularFileRecord(rootDirectory, relativePath)))
}

function recordsEqual(left, right) {
  return left.length === right.length && left.every((item, index) => (
    item.path === right[index]?.path && item.sha256 === right[index]?.sha256
  ))
}

async function serverOutputPaths(rootDirectory, outputDirectory = path.join(rootDirectory, "dist")) {
  const outputRoot = await canonicalDirectory(outputDirectory)
  const outputFiles = await collectRegularFiles(outputRoot, {
    include: (relative) => relative !== serverBuildManifestName,
    skipDirectory: (relative) => relative === "public",
  })
  return outputFiles.map((filePath) => `dist/${relativePosix(outputRoot, filePath)}`)
}

function assertOutputInventory(sourcePaths, outputPaths) {
  if (outputPaths.some((value) => !value.endsWith(".js") && !value.endsWith(".js.map"))) {
    throw new Error("服务端 dist 包含本次构建未声明的普通文件")
  }
  const expectedJavaScript = sourcePaths.filter((value) => !value.endsWith(".d.ts"))
    .map(expectedOutputForSource).sort()
  const actualJavaScript = outputPaths.filter((value) => value.endsWith(".js")).sort()
  if (!arraysEqual(actualJavaScript, expectedJavaScript)) {
    throw new Error("服务端 dist 清单与当前源码不一致")
  }
  const expectedSet = new Set(expectedJavaScript)
  if (outputPaths.some((value) => value.endsWith(".js.map") && !expectedSet.has(value.slice(0, -4)))) {
    throw new Error("服务端 dist 包含无源码对应的产物")
  }
  for (const requiredPath of ["dist/server.js", "dist/version.js"]) {
    if (!expectedSet.has(requiredPath)) throw new Error("服务端 dist 缺少关键入口")
  }
}

async function atomicWrite(filePath, contents) {
  const parent = await canonicalDirectory(path.dirname(filePath))
  const temporaryPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  let handle = null
  try {
    handle = await open(temporaryPath, "wx", 0o600)
    await handle.writeFile(contents, "utf8")
    await handle.chmod(0o600)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporaryPath, filePath)
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error
    })
  }
}

async function buildManifest(rootDirectory, outputDirectory = path.join(rootDirectory, "dist")) {
  const sourcePaths = await sourceInputPaths(rootDirectory)
  const outputPaths = await serverOutputPaths(rootDirectory, outputDirectory)
  assertOutputInventory(sourcePaths, outputPaths)
  const inputs = await buildInputRecords(rootDirectory)
  const outputs = await Promise.all(outputPaths.map(async (relativePath) => {
    const outputRelative = relativePath.slice("dist/".length)
    const filePath = path.join(outputDirectory, ...outputRelative.split("/"))
    const value = await lstat(filePath)
    if (value.isSymbolicLink() || !value.isFile()) throw new Error("服务端构建产物不安全")
    return {
      path: relativePath,
      sha256: createHash("sha256").update(await readFile(filePath)).digest("hex"),
    }
  }))
  const packageMetadata = JSON.parse(await readFile(path.join(rootDirectory, "package.json"), "utf8"))
  return {
    version: manifestVersion,
    appVersion: packageMetadata.version,
    inputs,
    outputs,
  }
}

export async function writeServerBuildManifest({ rootDirectory = process.cwd(), expectedInputs = null } = {}) {
  const root = await canonicalDirectory(rootDirectory)
  const distDirectory = path.join(root, "dist")
  const manifest = await buildManifest(root, distDirectory)
  if (expectedInputs && (!recordsEqual(expectedInputs, manifest.inputs)
    || !recordsEqual(expectedInputs, await buildInputRecords(root)))) {
    throw new Error("服务端构建期间输入发生变化，已拒绝发布产物")
  }
  await atomicWrite(path.join(distDirectory, serverBuildManifestName), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function runCompiler(rootDirectory, outputDirectory) {
  const compilerPath = path.join(rootDirectory, "node_modules/typescript/bin/tsc")
  const configPath = path.join(rootDirectory, "tsconfig.build.json")
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [compilerPath, "-p", configPath, "--outDir", outputDirectory], {
      cwd: rootDirectory,
      shell: false,
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? 1))
  })
}

async function publishStagedOutputs(rootDirectory, stagingDirectory) {
  const sourcePaths = await sourceInputPaths(rootDirectory)
  const stagedPaths = await serverOutputPaths(rootDirectory, stagingDirectory)
  assertOutputInventory(sourcePaths, stagedPaths)
  const distDirectory = path.join(rootDirectory, "dist")
  await mkdir(distDirectory, { recursive: true })
  const currentPaths = await serverOutputPaths(rootDirectory, distDirectory)
  const stagedSet = new Set(stagedPaths)
  if (currentPaths.some((relativePath) => !stagedSet.has(relativePath))) {
    throw new Error("现有 dist 包含本次构建不会生成的旧服务端产物")
  }
  for (const relativePath of stagedPaths) {
    const suffix = relativePath.slice("dist/".length)
    const sourcePath = path.join(stagingDirectory, ...suffix.split("/"))
    const destinationPath = path.join(distDirectory, ...suffix.split("/"))
    await mkdir(path.dirname(destinationPath), { recursive: true })
    await rename(sourcePath, destinationPath)
  }
}

export async function buildServer({ rootDirectory = fileURLToPath(new URL("..", import.meta.url)) } = {}) {
  const root = await canonicalDirectory(rootDirectory)
  const stagingDirectory = await mkdtemp(path.join(root, ".server-build-"))
  try {
    const initialInputs = await buildInputRecords(root)
    const compilerExitCode = await runCompiler(root, stagingDirectory)
    if (compilerExitCode !== 0) return compilerExitCode
    if (!recordsEqual(initialInputs, await buildInputRecords(root))) {
      throw new Error("服务端构建期间输入发生变化，已拒绝发布产物")
    }
    await publishStagedOutputs(root, stagingDirectory)
    await writeServerBuildManifest({ rootDirectory: root, expectedInputs: initialInputs })
    return 0
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  buildServer().then((exitCode) => {
    process.exitCode = exitCode
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "服务端构建失败"}\n`)
    process.exitCode = 1
  })
}
