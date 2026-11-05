/** Returns the exclude file to write, or undefined when `pattern` is already a whole line. */
export const appendExcludeLine = (contents: string, pattern: string): string | undefined => {
  const lines = contents.split(/\r?\n/)
  if (lines.some((line) => line.trim() === pattern)) return undefined
  const separator = contents.includes("\r\n") ? "\r\n" : "\n"
  const body = contents.length === 0 || contents.endsWith("\n") ? contents : `${contents}${separator}`
  return `${body}${pattern}${separator}`
}
