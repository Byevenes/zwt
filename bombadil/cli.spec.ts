import { always } from "@antithesishq/bombadil"
import { extract } from "@antithesishq/bombadil/terminal"
import { noReplacementChars, typeBasicInput } from "@antithesishq/bombadil/terminal/defaults"

export { noReplacementChars, typeBasicInput }

const linesOf = (grid: { readonly size: { readonly rows: number }; rowText: (index: number) => string }) => {
  const lines: Array<string> = []
  for (let row = 0; row < grid.size.rows; row++) lines.push(grid.rowText(row))
  return lines.join("\n")
}

const screenText = extract((state) => `${linesOf(state.scrollback)}\n${linesOf(state.grid)}`)

const exitStatus = extract((state) => state.exitStatus)

const hasStackFrame = (text: string) => /(?:^|\n)[^\n]*\bat [^\n]*\(/.test(text)

const isRequestedHelp = (text: string) =>
  text.includes("USAGE") && !text.includes("ERROR") && !text.includes("Command wizard")

const isUsageError = (text: string) =>
  text.includes("USAGE") && text.includes("ERROR") && !text.includes("Command wizard")

const exitedWith = (status: { readonly signal: string | null; readonly code: number } | null | undefined, code: number) => {
  if (status === null || status === undefined) return true
  return status.signal === null && status.code === code
}

export const helpShapedExitsZero = always(() => {
  const text = screenText.current ?? ""
  if (!isRequestedHelp(text)) return true
  return exitedWith(exitStatus.current, 0)
})

export const usageErrorExitsOne = always(() => {
  const text = screenText.current ?? ""
  if (!isUsageError(text)) return true
  return exitedWith(exitStatus.current, 1)
})

export const noUnhandledDefect = always(() => {
  const text = screenText.current ?? ""
  if (text.includes("Defect")) return false
  if (text.includes("Unhandled exception")) return false
  return !hasStackFrame(text)
})

export const exitZeroOrOne = always(() => {
  const status = exitStatus.current
  if (status === null || status === undefined) return true
  if (status.signal !== null) return false
  return status.code === 0 || status.code === 1
})
