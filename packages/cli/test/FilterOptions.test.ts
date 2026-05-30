import { describe, expect, it } from "vitest"
import { Option } from "effect"
import { buildFilter } from "../src/commands/FilterOptions.js"

/**
 * Unit coverage for `buildFilter`'s `Some([])` guard.
 *
 * The CLI's repeated `--types/--actors/--sources` flags are modeled as
 * `Options.repeated |> Options.optional`, which yields `Some([])` (an empty
 * array, NOT `None`) when the flag is present-but-empty or, depending on the
 * parser, when it is simply absent. An empty `types`/`actors`/`sources` array
 * on a Filter is event-REJECTING (`[].some(...)` / `[].includes(...)` are
 * always false), so blindly forwarding `Some([])` would silently drop every
 * event. `buildFilter` must therefore treat an empty array the same as absent:
 * omit the key entirely so the filter imposes no constraint on that field.
 */
describe("buildFilter", () => {
  it("treats Some([]) for types/actors/sources as absent (no event-rejecting keys)", () => {
    const filter = buildFilter({
      types: Option.some([]),
      actors: Option.some([]),
      sources: Option.some([]),
      since: Option.none(),
    })

    // No constraint keys at all — an empty/absent flag must not narrow.
    expect(filter).toEqual({})
    expect(Object.prototype.hasOwnProperty.call(filter, "types")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(filter, "actors")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(filter, "sources")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(filter, "since")).toBe(false)
  })

  it("omits keys for None across the board", () => {
    const filter = buildFilter({
      types: Option.none(),
      actors: Option.none(),
      sources: Option.none(),
      since: Option.none(),
    })
    expect(filter).toEqual({})
  })

  it("forwards non-empty arrays and a present since", () => {
    const filter = buildFilter({
      types: Option.some(["canvas.*"]),
      actors: Option.some(["alice"]),
      sources: Option.some(["cli"]),
      since: Option.some(123),
    })
    expect(filter.types).toEqual(["canvas.*"])
    expect(filter.actors).toEqual(["alice"])
    expect(filter.sources).toEqual(["cli"])
    expect(filter.since).toBe(123)
  })

  it("keeps since: 0 (a falsy-but-present value) rather than dropping it", () => {
    const filter = buildFilter({
      types: Option.none(),
      actors: Option.none(),
      sources: Option.none(),
      since: Option.some(0),
    })
    expect(Object.prototype.hasOwnProperty.call(filter, "since")).toBe(true)
    expect(filter.since).toBe(0)
  })
})
