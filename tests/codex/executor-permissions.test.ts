import { spawn } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import * as executorModule from "../../src/codex/executor.js"
import type { CodexInvocation } from "../../src/codex/executor.js"

type ResolveReferenceClassifierRoots = (cwd: string, roots: string[]) => Promise<{
  cwd: string
  readableRoots: string[]
}>

type ValidateReferenceClassifierCliCapabilities = (
  execHelp: string,
  sandboxHelp: string,
  platform: NodeJS.Platform,
) => void

type ProcessResult = {
  code: number | null
  stdout: string
  stderr: string
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), prefix))
  const canonical = await realpath(created)
  temporaryRoots.push(canonical)
  return canonical
}

function referenceClassifierInvocation(cwd: string, readableRoots: string[]): CodexInvocation {
  return {
    cwd,
    model: "gpt-test",
    reasoningEffort: "minimal",
    timeoutMs: 30_000,
    prompt: "classify",
    outputSchema: { type: "object" },
    accessMode: "reference-classifier" as unknown as CodexInvocation["accessMode"],
    readableRoots,
  }
}

function configOverrides(args: string[]): string[] {
  return args.flatMap((argument, index) => argument === "-c" && args[index + 1] ? [args[index + 1]!] : [])
}

function sandboxMode(args: string[]): string | null {
  const index = args.indexOf("--sandbox")
  return index >= 0 ? args[index + 1] ?? null : null
}

function optionValues(args: string[], option: string): string[] {
  return args.flatMap((argument, index) => argument === option && args[index + 1] ? [args[index + 1]!] : [])
}

function resolveRootsFunction(): ResolveReferenceClassifierRoots {
  const candidate = (executorModule as Record<string, unknown>).resolveReferenceClassifierRoots
  expect(candidate).toBeTypeOf("function")
  return candidate as ResolveReferenceClassifierRoots
}

function capabilityValidator(): ValidateReferenceClassifierCliCapabilities {
  const candidate = (executorModule as Record<string, unknown>).validateReferenceClassifierCliCapabilities
  expect(candidate).toBeTypeOf("function")
  return candidate as ValidateReferenceClassifierCliCapabilities
}

function run(command: string, args: string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout += chunk })
    child.stderr.on("data", (chunk: string) => { stderr += chunk })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, stdout, stderr }))
  })
}

async function seatbeltArgs(cwd: string, codexArgs: string[], command: string[]): Promise<string[]> {
  const overrides = configOverrides(codexArgs)
  expect(overrides).toContain('default_permissions="reference-classifier"')
  const root = await run("codex", ["sandbox", "--help"], cwd)
  const rootHelp = `${root.stdout}\n${root.stderr}`
  let commandPrefix = ["sandbox"]
  let profileOption: "--permission-profile" | "--permissions-profile" | null
    = rootHelp.includes("--permission-profile") ? "--permission-profile"
      : rootHelp.includes("--permissions-profile") ? "--permissions-profile" : null
  if (!profileOption) {
    const scoped = await run("codex", ["sandbox", "macos", "--help"], cwd)
    const scopedHelp = `${scoped.stdout}\n${scoped.stderr}`
    commandPrefix = ["sandbox", "macos"]
    profileOption = scopedHelp.includes("--permission-profile") ? "--permission-profile"
      : scopedHelp.includes("--permissions-profile") ? "--permissions-profile" : null
  }
  expect(profileOption).not.toBeNull()
  return [
    ...commandPrefix,
    profileOption!, "reference-classifier",
    "-C", cwd,
    ...overrides.flatMap((override) => ["-c", override]),
    "--",
    ...command,
  ]
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("测试监听地址不可用")
  return address.port
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

describe("Reference classifier Codex permissions", () => {
  it("uses a strict inline permission profile without the legacy sandbox flag", () => {
    const cwd = "/safe/current-snapshot"
    const repository = "/safe/current-snapshot/java-project"
    const args = executorModule.buildCodexArgs(
      referenceClassifierInvocation(cwd, [repository]),
      "/safe/runtime/output-schema.json",
      "/safe/runtime/result.json",
    )
    const overrides = configOverrides(args)

    expect(args).toContain("--strict-config")
    expect(args).toContain("--ephemeral")
    expect(args).toContain("--ignore-user-config")
    expect(args).toContain("--ignore-rules")
    expect(optionValues(args, "--disable")).toEqual(expect.arrayContaining([
      "apps",
      "browser_use",
      "browser_use_external",
      "computer_use",
      "image_generation",
      "in_app_browser",
      "multi_agent",
      "plugins",
      "workspace_dependencies",
    ]))
    expect(args).not.toContain("--profile-v2")
    expect(sandboxMode(args)).toBeNull()
    expect(overrides).toContain('default_permissions="reference-classifier"')
    expect(overrides).toContain('web_search="disabled"')
    expect(overrides).toContain("permissions.reference-classifier.network.enabled=false")
    expect(overrides.some((override) => (
      override.startsWith("permissions.reference-classifier.filesystem=")
      && override.includes('\":root\"=\"deny\"')
      && override.includes('\":minimal\"=\"read\"')
      && override.includes('\":tmpdir\"=\"deny\"')
      && (process.platform === "win32" || override.includes('\":slash_tmp\"=\"deny\"'))
      && override.includes(`${JSON.stringify(repository)}=\"read\"`)
    ))).toBe(true)
  })

  it("keeps ordinary read-only and support diagnostic sandbox behavior unchanged", () => {
    const base = referenceClassifierInvocation("/safe/workspace", [])
    const readOnly = executorModule.buildCodexArgs(
      { ...base, accessMode: "read-only" },
      "/safe/schema.json",
      "/safe/result.json",
    )
    const diagnostic = executorModule.buildCodexArgs(
      { ...base, accessMode: "diagnostic" },
      "/safe/schema.json",
      "/safe/result.json",
    )

    expect(sandboxMode(readOnly)).toBe("read-only")
    expect(sandboxMode(diagnostic)).toBe("danger-full-access")
    expect(readOnly).not.toContain("--strict-config")
    expect(diagnostic).not.toContain("--strict-config")
    expect(configOverrides(readOnly).some((item) => item.startsWith("default_permissions="))).toBe(false)
    expect(configOverrides(diagnostic).some((item) => item.startsWith("default_permissions="))).toBe(false)
    expect(optionValues(readOnly, "--disable")).toEqual([])
    expect(optionValues(diagnostic, "--disable")).toEqual([])
  })

  it("canonicalizes and deduplicates exact snapshot directories", async () => {
    const fixture = await temporaryDirectory("reference-roots-")
    const workspace = path.join(fixture, "snapshot")
    const repository = path.join(workspace, "java-project")
    await mkdir(repository, { recursive: true })

    await expect(resolveRootsFunction()(workspace, [repository, repository])).resolves.toEqual({
      cwd: workspace,
      readableRoots: [repository],
    })
  })

  it("fails closed for empty, parent, whole-workspace, file, outside, and symlink roots", async () => {
    const fixture = await temporaryDirectory("reference-invalid-roots-")
    const workspace = path.join(fixture, "snapshot")
    const repository = path.join(workspace, "java-project")
    const codeFile = path.join(repository, "OrderService.java")
    const outside = path.join(fixture, "runtime-data")
    const linkedRepository = path.join(workspace, "linked-java-project")
    const parentSegmentRepository = `${repository}${path.sep}..${path.sep}${path.basename(repository)}`
    await mkdir(repository, { recursive: true })
    await mkdir(outside)
    await writeFile(codeFile, "class OrderService {}\n", "utf8")
    await symlink(repository, linkedRepository, "dir")
    const resolveRoots = resolveRootsFunction()

    await expect(resolveRoots(workspace, [])).rejects.toThrow()
    await expect(resolveRoots(workspace, [fixture])).rejects.toThrow()
    await expect(resolveRoots(workspace, [workspace])).rejects.toThrow()
    await expect(resolveRoots(workspace, [codeFile])).rejects.toThrow()
    await expect(resolveRoots(workspace, [outside])).rejects.toThrow()
    await expect(resolveRoots(workspace, [linkedRepository])).rejects.toThrow()
    await expect(resolveRoots(workspace, [parentSegmentRepository])).rejects.toThrow()
  })

  it("rejects missing strict-config, permission-profile, and unsupported platform capabilities", () => {
    const validate = capabilityValidator()
    expect(() => validate(
      "--strict-config --ephemeral --ignore-user-config --disable",
      "--permissions-profile <NAME>",
      "darwin",
    )).not.toThrow()
    expect(() => validate("--ephemeral --ignore-user-config", "--permissions-profile <NAME>", "darwin")).toThrow()
    expect(() => validate("--strict-config --ephemeral --ignore-user-config --disable", "--help", "darwin")).toThrow()
    expect(() => validate(
      "--strict-config --ephemeral --ignore-user-config",
      "--permissions-profile <NAME>",
      "darwin",
    )).toThrow()
    expect(() => validate(
      "--strict-config --ephemeral --ignore-user-config --disable",
      "--permissions-profile <NAME>",
      "aix",
    )).toThrow()
  })

  it("fails closed before invocation when the installed CLI lacks profile capabilities", async () => {
    const fixture = await temporaryDirectory("reference-capability-gate-")
    const workspace = path.join(fixture, "snapshot")
    const repository = path.join(workspace, "java-project")
    const commandDirectory = path.join(fixture, "bin")
    const runtimeTemp = path.join(fixture, "runtime-temp")
    const actualInvocationMarker = path.join(fixture, "actual-invocation.marker")
    const fakeCodex = path.join(commandDirectory, "codex")
    await mkdir(repository, { recursive: true })
    await mkdir(commandDirectory)
    await mkdir(runtimeTemp)
    await writeFile(fakeCodex, [
      "#!/bin/sh",
      "if [ \"$1\" = \"exec\" ] && [ \"$2\" = \"--help\" ]; then",
      "  printf '%s\\n' '--ephemeral --ignore-user-config'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"sandbox\" ]; then",
      "  printf '%s\\n' '--permissions-profile <NAME>'",
      "  exit 0",
      "fi",
      `printf '%s\\n' invoked > ${JSON.stringify(actualInvocationMarker)}`,
      "exit 0",
    ].join("\n"), { encoding: "utf8", mode: 0o700 })
    await chmod(fakeCodex, 0o700)
    const originalPath = process.env.PATH
    const originalTmpdir = process.env.TMPDIR
    process.env.PATH = `${commandDirectory}${path.delimiter}${originalPath ?? ""}`
    process.env.TMPDIR = runtimeTemp
    const runner = new executorModule.LocalCodexCommandRunner()
    try {
      await expect(runner.invoke(referenceClassifierInvocation(workspace, [repository])))
        .rejects.toThrow("参考分类 Codex 最小权限能力不可用")
      await expect(readFile(actualInvocationMarker, "utf8")).rejects.toThrow()
      expect(await readdir(runtimeTemp)).toEqual([])
    } finally {
      await runner.shutdown()
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = originalTmpdir
    }
  })

  it("fails closed before invocation when the installed sandbox cannot deny slash tmp", async () => {
    const fixture = await temporaryDirectory("reference-sandbox-probe-")
    const workspace = path.join(fixture, "snapshot")
    const repository = path.join(workspace, "java-project")
    const commandDirectory = path.join(fixture, "bin")
    const actualInvocationMarker = path.join(fixture, "actual-invocation.marker")
    const fakeCodex = path.join(commandDirectory, "codex")
    await mkdir(repository, { recursive: true })
    await mkdir(commandDirectory)
    await writeFile(fakeCodex, [
      "#!/bin/sh",
      "if [ \"$1\" = \"exec\" ] && [ \"$2\" = \"--help\" ]; then",
      "  printf '%s\\n' '--strict-config --ephemeral --ignore-user-config --disable'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"sandbox\" ] && [ \"$3\" = \"--help\" ]; then",
      "  printf '%s\\n' '--permissions-profile <NAME>'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"sandbox\" ]; then exit 41; fi",
      `printf '%s\\n' invoked > ${JSON.stringify(actualInvocationMarker)}`,
      "exit 0",
    ].join("\n"), { encoding: "utf8", mode: 0o700 })
    await chmod(fakeCodex, 0o700)
    const originalPath = process.env.PATH
    process.env.PATH = `${commandDirectory}${path.delimiter}${originalPath ?? ""}`
    const slashTmpRoot = process.platform === "win32" ? null : await realpath("/tmp")
    const beforeProbeFiles = slashTmpRoot === null
      ? []
      : (await readdir(slashTmpRoot)).filter((name) => name.startsWith("telegram-support-codex-capability-"))
    const runner = new executorModule.LocalCodexCommandRunner()
    try {
      await expect(runner.invoke(referenceClassifierInvocation(workspace, [repository])))
        .rejects.toThrow("参考分类 Codex 最小权限能力不可用，请管理员升级 Codex CLI")
      await expect(readFile(actualInvocationMarker, "utf8")).rejects.toThrow()
      if (slashTmpRoot !== null) {
        expect((await readdir(slashTmpRoot)).filter((name) => (
          name.startsWith("telegram-support-codex-capability-") && !beforeProbeFiles.includes(name)
        ))).toEqual([])
      }
    } finally {
      await runner.shutdown()
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it("cleans private runtime files after successful and failed classifier invocations", async () => {
    const fixture = await temporaryDirectory("reference-runtime-cleanup-")
    const workspace = path.join(fixture, "snapshot")
    const repository = path.join(workspace, "java-project")
    const commandDirectory = path.join(fixture, "bin")
    const runtimeTemp = path.join(fixture, "runtime-temp")
    const failureMarker = path.join(fixture, "fail.marker")
    const fakeCodex = path.join(commandDirectory, "codex")
    await mkdir(repository, { recursive: true })
    await mkdir(commandDirectory)
    await mkdir(runtimeTemp)
    await writeFile(fakeCodex, [
      "#!/bin/sh",
      "if [ \"$1\" = \"exec\" ] && [ \"$2\" = \"--help\" ]; then",
      "  printf '%s\\n' '--strict-config --ephemeral --ignore-user-config --disable'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"sandbox\" ]; then",
      "  printf '%s\\n' '--permissions-profile <NAME>'",
      "  exit 0",
      "fi",
      `if [ -f ${JSON.stringify(failureMarker)} ]; then exit 42; fi`,
      "while [ \"$#\" -gt 0 ]; do",
      "  if [ \"$1\" = \"--output-last-message\" ]; then",
      "    shift",
      "    printf '%s' '{\"ok\":true}' > \"$1\"",
      "  fi",
      "  shift",
      "done",
      "exit 0",
    ].join("\n"), { encoding: "utf8", mode: 0o700 })
    await chmod(fakeCodex, 0o700)
    const originalPath = process.env.PATH
    const originalTmpdir = process.env.TMPDIR
    process.env.PATH = `${commandDirectory}${path.delimiter}${originalPath ?? ""}`
    process.env.TMPDIR = runtimeTemp
    const runner = new executorModule.LocalCodexCommandRunner()
    try {
      await expect(runner.invoke(referenceClassifierInvocation(workspace, [repository])))
        .resolves.toEqual(expect.objectContaining({ output: '{"ok":true}' }))
      expect(await readdir(runtimeTemp)).toEqual([])

      await writeFile(failureMarker, "fail\n", "utf8")
      await expect(runner.invoke(referenceClassifierInvocation(workspace, [repository])))
        .rejects.toBeInstanceOf(executorModule.CodexExecutionError)
      expect(await readdir(runtimeTemp)).toEqual([])
    } finally {
      await runner.shutdown()
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = originalTmpdir
    }
  })

  it.runIf(process.platform === "darwin")(
    "enforces real Seatbelt reads and network denial for the exact snapshot only",
    async () => {
      const fixture = await temporaryDirectory("reference-seatbelt-")
      const workspace = path.join(fixture, "snapshot")
      const repository = path.join(workspace, "java-project")
      const codeDirectory = path.join(repository, "src", "main", "java")
      const snapshotMarker = path.join(repository, "snapshot.marker")
      const codeEvidence = path.join(codeDirectory, "OrderService.java")
      const runtimeData = path.join(fixture, "runtime-data")
      const secretMarker = path.join(runtimeData, "secret.marker")
      const databaseMarker = path.join(runtimeData, "support.sqlite")
      const parentMarker = path.join(fixture, "AGENTS.md")
      const snapshotEscape = path.join(repository, "outside-secret-link.marker")
      const slashTmpFixture = await mkdtemp("/tmp/reference-slash-tmp-")
      const canonicalSlashTmpFixture = await realpath(slashTmpFixture)
      temporaryRoots.push(canonicalSlashTmpFixture)
      const slashTmpMarker = path.join(canonicalSlashTmpFixture, "outside-slash-tmp.marker")
      await mkdir(codeDirectory, { recursive: true })
      await mkdir(runtimeData)
      await writeFile(snapshotMarker, "SNAPSHOT_MARKER\n", "utf8")
      await writeFile(codeEvidence, "// ORDER_CODE_EVIDENCE\n", "utf8")
      await writeFile(secretMarker, "OUTSIDE_SECRET\n", "utf8")
      await writeFile(databaseMarker, "OUTSIDE_DATABASE\n", "utf8")
      await writeFile(parentMarker, "OUTSIDE_PARENT\n", "utf8")
      await symlink(secretMarker, snapshotEscape, "file")
      await writeFile(slashTmpMarker, "OUTSIDE_SLASH_TMP\n", "utf8")

      const server = createServer((socket) => socket.end())
      const port = await listen(server)
      try {
        const unsandboxedNetwork = await run("/usr/bin/nc", ["-z", "-w", "1", "127.0.0.1", String(port)], workspace)
        expect(unsandboxedNetwork.code).toBe(0)

        const codexArgs = executorModule.buildCodexArgs(
          referenceClassifierInvocation(workspace, [repository]),
          path.join(fixture, "schema.json"),
          path.join(fixture, "result.json"),
        )
        const probe = [
          "probe_failed=0",
          "if /bin/cat \"$1\" >/dev/null 2>&1; then echo SNAPSHOT_READABLE; else echo SNAPSHOT_DENIED; probe_failed=1; fi",
          "if /usr/bin/grep -q ORDER_CODE_EVIDENCE \"$2\"; then echo CODE_EVIDENCE_READABLE; else echo CODE_EVIDENCE_DENIED; probe_failed=1; fi",
          "if /bin/cat \"$3\" >/dev/null 2>&1; then echo SECRET_READABLE; probe_failed=1; else echo SECRET_DENIED; fi",
          "if /bin/cat \"$4\" >/dev/null 2>&1; then echo DATABASE_READABLE; probe_failed=1; else echo DATABASE_DENIED; fi",
          "if /bin/cat \"$5\" >/dev/null 2>&1; then echo PARENT_READABLE; probe_failed=1; else echo PARENT_DENIED; fi",
          "if /bin/cat \"$6\" >/dev/null 2>&1; then echo SYMLINK_ESCAPE_READABLE; probe_failed=1; else echo SYMLINK_ESCAPE_DENIED; fi",
          "if /bin/cat \"$7\" >/dev/null 2>&1; then echo SLASH_TMP_READABLE; else echo SLASH_TMP_DENIED; fi",
          "if /usr/bin/nc -z -w 1 127.0.0.1 \"$8\" >/dev/null 2>&1; then echo NETWORK_REACHABLE; probe_failed=1; else echo NETWORK_DENIED; fi",
          "exit \"$probe_failed\"",
        ].join("\n")
        const result = await run("codex", await seatbeltArgs(workspace, codexArgs, [
          "/bin/sh", "-c", probe, "reference-seatbelt-probe",
          snapshotMarker, codeEvidence, secretMarker, databaseMarker, parentMarker, snapshotEscape, slashTmpMarker,
          String(port),
        ]), workspace)

        expect(result, result.stderr).toEqual(expect.objectContaining({ code: 0 }))
        expect(result.stdout).toContain("SNAPSHOT_READABLE")
        expect(result.stdout).toContain("CODE_EVIDENCE_READABLE")
        expect(result.stdout).toContain("SECRET_DENIED")
        expect(result.stdout).toContain("DATABASE_DENIED")
        expect(result.stdout).toContain("PARENT_DENIED")
        expect(result.stdout).toContain("SYMLINK_ESCAPE_DENIED")
        expect(result.stdout).toContain("NETWORK_DENIED")
        expect(result.stdout).not.toMatch(
          /SECRET_READABLE|DATABASE_READABLE|PARENT_READABLE|SYMLINK_ESCAPE_READABLE|NETWORK_REACHABLE/u,
        )
        expect(result.stdout).toMatch(/SLASH_TMP_(?:READABLE|DENIED)/u)
        if (result.stdout.includes("SLASH_TMP_READABLE")) {
          await expect(executorModule.verifyReferenceClassifierSandboxCapabilities(workspace, [repository]))
            .rejects.toThrow()
        } else {
          await expect(executorModule.verifyReferenceClassifierSandboxCapabilities(workspace, [repository]))
            .resolves.toBeUndefined()
        }
      } finally {
        await close(server)
      }
    },
    30_000,
  )

  it.runIf(process.platform === "darwin")(
    "keeps concurrent inline profiles isolated without a shared profile file",
    async () => {
      const fixture = await temporaryDirectory("reference-concurrent-")
      const workspace = path.join(fixture, "snapshot")
      const firstRepository = path.join(workspace, "java-project")
      const secondRepository = path.join(workspace, "sfzf-web")
      const firstMarker = path.join(firstRepository, "first.marker")
      const secondMarker = path.join(secondRepository, "second.marker")
      await mkdir(firstRepository, { recursive: true })
      await mkdir(secondRepository)
      await writeFile(firstMarker, "FIRST\n", "utf8")
      await writeFile(secondMarker, "SECOND\n", "utf8")
      const probe = [
        "if ! /bin/cat \"$1\" >/dev/null 2>&1; then exit 31; fi",
        "if /bin/cat \"$2\" >/dev/null 2>&1; then exit 32; fi",
        "echo CONCURRENT_PROFILE_ISOLATED",
      ].join("\n")
      const firstArgs = executorModule.buildCodexArgs(
        referenceClassifierInvocation(workspace, [firstRepository]),
        path.join(fixture, "first-schema.json"),
        path.join(fixture, "first-result.json"),
      )
      const secondArgs = executorModule.buildCodexArgs(
        referenceClassifierInvocation(workspace, [secondRepository]),
        path.join(fixture, "second-schema.json"),
        path.join(fixture, "second-result.json"),
      )

      const [firstSeatbeltArgs, secondSeatbeltArgs] = await Promise.all([
        seatbeltArgs(workspace, firstArgs, [
          "/bin/sh", "-c", probe, "first-profile", firstMarker, secondMarker,
        ]),
        seatbeltArgs(workspace, secondArgs, [
          "/bin/sh", "-c", probe, "second-profile", secondMarker, firstMarker,
        ]),
      ])
      const [first, second] = await Promise.all([
        run("codex", firstSeatbeltArgs, workspace),
        run("codex", secondSeatbeltArgs, workspace),
      ])

      expect(first, first.stderr).toEqual(expect.objectContaining({ code: 0 }))
      expect(second, second.stderr).toEqual(expect.objectContaining({ code: 0 }))
      expect(first.stdout).toContain("CONCURRENT_PROFILE_ISOLATED")
      expect(second.stdout).toContain("CONCURRENT_PROFILE_ISOLATED")
    },
    30_000,
  )
})
