import { z } from "zod"

export type AppEnv = {
  host: string
  port: number
  dataDir: string
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent"
}

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  CONTAINER_BIND: z.enum(["true", "false"]).default("false"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3210),
  DATA_DIR: z.string().trim().min(1).default("./data"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
}).superRefine((env, context) => {
  const loopback = env.HOST === "127.0.0.1" || env.HOST === "::1" || env.HOST === "localhost"
  const containerBind = env.HOST === "0.0.0.0" && env.CONTAINER_BIND === "true"
  if (!loopback && !containerBind) {
    context.addIssue({ code: "custom", path: ["HOST"], message: "HOST 只允许本机回环地址" })
  }
})

export function loadEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.parse(input)
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    dataDir: parsed.DATA_DIR,
    logLevel: parsed.LOG_LEVEL,
  }
}
