/// <reference types="bun" />
// @ts-expect-error fixture only: this identifier is not declared
export const value = missing
// oxlint-disable-next-line zwt/no-line-comments
// temporary exception next to a disable directive
// prettier-ignore
export const packed = 1
// @vitest-environment node
export const env = "node"
