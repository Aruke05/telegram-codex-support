import { copyFile, mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

const publicRoot = resolve("dist/public")

await rm(publicRoot, { recursive: true, force: true })
await mkdir(publicRoot, { recursive: true })
await Promise.all([
  copyFile(resolve("web/index.html"), resolve(publicRoot, "index.html")),
  copyFile(resolve("web/styles.css"), resolve(publicRoot, "styles.css")),
])
