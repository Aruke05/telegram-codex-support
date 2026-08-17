import { SAFE_MAGICBOOK_KEYS } from "../magicbook/types.js"

const allowedMagicBookFields = new Set<string>(SAFE_MAGICBOOK_KEYS)

export function isMagicBookFieldAllowed(key: string): boolean {
  return allowedMagicBookFields.has(key)
}
