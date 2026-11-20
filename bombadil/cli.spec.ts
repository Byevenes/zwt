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

export const helpShapedExitsZero = always(() => {
  const text = screenText.current ?? ""
  const helpShaped = text.includes("USAGE") && !text.includes("Command wizard")
  if (!helpShaped) return true
  const status = exitStatus.current
  if (status === null || status === undefined) return true
  return status.signal === null && status.code === 0
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
