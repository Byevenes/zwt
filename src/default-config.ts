import exampleToml from "../examples/zwt.toml"
import type { ZwtConfig } from "./services/Config.ts"

type Primitive = string | number | boolean | bigint | null | undefined

/**
 * `T` when a Motherload TOML type fits `ZwtConfig`, `never` when it does not.
 * Unknown keys count as a miss, same as `onExcessProperty: "error"`.
 * Schema filters (email, tokens, identity references) stay runtime-only.
 */
export type MatchesZwtConfig<T> = T extends ZwtConfig ? NoExcess<T, ZwtConfig> extends never ? never : T : never

export type IsZwtConfigShape<T> = [MatchesZwtConfig<T>] extends [never] ? false : true

type NoExcess<Value, Shape> = Shape extends unknown ? NoExcessBranch<Value, Shape> : never

type NoExcessBranch<Value, Shape> = [Value] extends [Primitive] ? [Value] extends [Shape] ? Value : never
  : [Value] extends [readonly [unknown?, ...unknown[]]] ? TupleExcess<Value, Shape>
  : [Value] extends [readonly unknown[]] ? ArrayExcess<Value, Shape>
  : [Value] extends [object] ? ObjectExcess<Value, Shape>
  : never

type ArrayElement<Shape> = Shape extends readonly (infer Element)[] ? Element : never

/** One tuple element at a time, so optional keys on a single row are still checked. */
type TupleExcess<Value, Shape> = [Shape] extends [readonly unknown[]] ? Value extends readonly [] ? Value
  : Value extends readonly [infer Head, ...infer Rest] ? NoExcess<Head, ArrayElement<Shape>> extends never ? never
    : TupleExcess<Rest, Shape> extends never ? never
    : Value
  : never
  : never

type ArrayExcess<Value, Shape> = [Shape] extends [readonly (infer Element)[]]
  ? Value extends readonly (infer Item)[] ? NoExcess<Item, Element> extends never ? never : Value
  : never
  : never

type ObjectExcess<Value, Shape> = [Shape] extends [object]
  ? Exclude<keyof Value, keyof Shape> extends never
    ? {
      [Key in keyof Value]-?: NoExcess<Value[Key], Key extends keyof Shape ? Shape[Key] : never> extends never ? Key : never
    }[keyof Value] extends never ? Value : never
  : never
  : never

/**
 * Bundled example config (`examples/zwt.toml`), typed from the file.
 * The annotation is `never` when the file drifts from `ZwtConfig`.
 * The CLI does not load this module; `parseConfig` still validates at runtime.
 */
export const defaultConfig: MatchesZwtConfig<typeof exampleToml> = exampleToml
