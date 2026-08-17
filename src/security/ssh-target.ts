import { isIP } from "node:net"

const sshUsernamePattern = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/u
const dnsHostnamePattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*\.?$/u

export function isSafeSshUsername(value: string): boolean {
  return sshUsernamePattern.test(value)
}

export function isSafeSshHost(value: string): boolean {
  return !value.startsWith("-") && (isIP(value) !== 0 || dnsHostnamePattern.test(value))
}

export function assertSafeSshTarget(username: string, host: string): void {
  if (!isSafeSshUsername(username)) throw new Error("SSH 用户名格式无效")
  if (!isSafeSshHost(host)) throw new Error("SSH 主机格式无效")
}

export function sshTargetArguments(username: string, host: string): string[] {
  assertSafeSshTarget(username, host)
  return ["-l", username, "--", host]
}
