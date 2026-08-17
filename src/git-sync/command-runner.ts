import { spawn } from "node:child_process"

import type { CommandRunner, RunOptions, RunResult } from "./types.js"

const MAX_OUTPUT_LENGTH = 1024 * 1024

export class NodeCommandRunner implements CommandRunner {
  run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        detached: process.platform !== "win32",
      })
      let stdout = ""
      let stderr = ""
      let settled = false
      let timedOut = false
      let forceKill: ReturnType<typeof setTimeout> | null = null
      const terminate = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch {
          // 进程可能已经退出。
        }
      }
      const timeout = setTimeout(() => {
        if (settled) return
        timedOut = true
        terminate("SIGTERM")
        forceKill = setTimeout(() => terminate("SIGKILL"), 2_000)
        forceKill.unref()
      }, options.timeoutMs ?? 120_000)

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_LENGTH) stdout += chunk.toString("utf8")
      })
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_LENGTH) stderr += chunk.toString("utf8")
      })
      child.once("error", () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (forceKill) clearTimeout(forceKill)
        reject(new Error("命令执行失败"))
      })
      child.once("close", (code) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (forceKill) clearTimeout(forceKill)
        resolve({ exitCode: code ?? 1, stdout, stderr, timedOut })
      })
    })
  }
}
