import path from "node:path"

import { describe, expect, it } from "vitest"

import { ReadonlyAgentToolBroker } from "../../src/diagnostics/readonly-agent-tool-broker.js"
import { validateTrustedCommandObservation } from "../../src/support/trusted-command-observation.js"

const workspacePath = path.join(path.sep, "tmp", "readonly-agent-workspace")
const context = { workspacePath, codeRoots: [path.join(workspacePath, "code")] }

function remote(command: string): string {
  return `ssh -F ${path.join(workspacePath, "ssh_config")} support-1 ${JSON.stringify(command)}`
}

describe("API 模型只读工具边界", () => {
  it("不向模型暴露任意 shell 命令工具", () => {
    const broker = new ReadonlyAgentToolBroker()
    expect(broker.definitions().map((definition) => definition.name)).not.toContain("run_readonly_command")
  })

  it.each([
    `python3 -c 'open("/tmp/x","w").write("x")'`,
    `node -e 'require("fs").writeFileSync("/tmp/x","x")'`,
    `sh -c 'touch /tmp/x'`,
    `uptime && python3 -c 'open("/tmp/x","w").write("x")'`,
  ])("拒绝未知解释器 shell 包装和复合远端命令: %s", (command) => {
    expect(validateTrustedCommandObservation({ command: remote(command), output: "", exitCode: 0 }, context)).toBeNull()
  })

  it.each([
    ["uptime", "server"],
    ["free -m", "server"],
    ["df -h", "server"],
    ["cat /proc/loadavg", "server"],
    ["ip -s link", "server"],
    ["systemctl is-active sfzf-service", "server"],
    ["journalctl --no-pager -u sfzf-service --since '30 minutes ago' -n 300 -o cat", "log"],
    ["journalctl --no-pager -u sfzf-service --since '30 minutes ago' -n 1000 -o cat", "log"],
    ["redis-cli --raw -n 0 GET order:1", "redis"],
  ])("保留结构化工具生成的只读命令: %s", (command, source) => {
    expect(validateTrustedCommandObservation({ command: remote(command), output: "", exitCode: 0 }, context)).toMatchObject({
      kind: "evidence",
      source,
    })
  })
})
