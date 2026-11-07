export interface ActionEntry {
  readonly timestamp: string
  readonly command: string
  readonly result: string
}

/** Oldest lines are dropped once the file passes this size. The newest line is always kept. */
export const maxActionLogBytes = 256 * 1024

const maxResultLength = 300
const encoder = new TextEncoder()

const bytes = (text: string) => encoder.encode(text).length

export const actionLogPath = (env: Readonly<Record<string, string | undefined>>): string => {
  const base = env.XDG_STATE_HOME || `${env.HOME ?? "~"}/.local/state`
  return `${base}/zwt/actions.log`
}

export const actionResult = (error: unknown): string => {
  const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : ""
  const flat = message.replace(/\s+/g, " ").trim()
  if (flat.length === 0) return "error"
  const clipped = flat.length > maxResultLength ? `${flat.slice(0, maxResultLength)}...` : flat
  return `error: ${clipped}`
}

export const encodeEntry = (entry: ActionEntry): string =>
  JSON.stringify({ timestamp: entry.timestamp, command: entry.command, result: entry.result })

const isEntry = (value: unknown): value is ActionEntry => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.timestamp === "string" && typeof entry.command === "string" && typeof entry.result === "string"
}

/** Keeps well-formed lines. A bad line does not hide the rest of the file. */
export const parseActionLog = (source: string): ReadonlyArray<ActionEntry> => {
  const entries: Array<ActionEntry> = []
  for (const line of source.split("\n")) {
    if (line.trim() === "") continue
    try {
      const value: unknown = JSON.parse(line)
      if (!isEntry(value)) continue
      entries.push({ timestamp: value.timestamp, command: value.command, result: value.result })
    } catch {
      continue
    }
  }
  return entries
}

export const renderActionLog = (entries: ReadonlyArray<ActionEntry>): string =>
  entries.map((entry) => `${entry.timestamp} ${entry.result} ${entry.command}`).join("\n")

/** Append one JSON line, then drop oldest lines until the file fits. */
export const appendCapped = (existing: string, entry: ActionEntry, maxBytes: number): string => {
  const lines = existing.split("\n").filter((line) => line.length > 0)
  lines.push(encodeEntry(entry))
  while (lines.length > 1 && bytes(`${lines.join("\n")}\n`) > maxBytes) lines.shift()
  return `${lines.join("\n")}\n`
}
