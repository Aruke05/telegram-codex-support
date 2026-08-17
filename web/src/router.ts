import type { RouteKey } from "./types.js"

export const routeKeys = ["overview", "projects", "connections", "replies", "chat", "memories", "docs", "models", "runtime", "transfer", "settings"] as const

export type NormalizedRoute = RouteKey | "groups" | "security"

export function normalizeRoute(hash: string): NormalizedRoute {
  const value = hash.replace(/^#\/?/, "")
  if (value === "groups" || value === "security") return value
  return routeKeys.includes(value as RouteKey) ? value as RouteKey : "overview"
}

type HashSource = {
  location: { hash: string }
  addEventListener(type: "hashchange", listener: () => void): void
  removeEventListener(type: "hashchange", listener: () => void): void
}

export function watchRoutes(source: HashSource, onRoute: (route: RouteKey) => void): () => void {
  const notify = () => {
    const route = normalizeRoute(source.location.hash)
    onRoute(route === "groups" ? "connections" : route === "security" ? "settings" : route)
  }
  source.addEventListener("hashchange", notify)
  notify()
  return () => source.removeEventListener("hashchange", notify)
}
