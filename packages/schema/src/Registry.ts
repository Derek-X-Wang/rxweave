import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { DuplicateEventType, UnknownEventType } from "./Errors.js"

const hex = (input: string): string =>
  bytesToHex(sha256(new TextEncoder().encode(input)))

export interface EventDef<A = unknown, I = unknown> {
  readonly type: string
  readonly version?: number
  readonly payload: Schema.Schema<A, I>
}

export const defineEvent = <A, I>(
  type: string,
  payload: Schema.Schema<A, I>,
  version = 1,
): EventDef<A, I> => ({ type, version, payload })

export class EventDefWire extends Schema.Class<EventDefWire>("EventDefWire")({
  type: Schema.String,
  version: Schema.Number,
  payloadSchema: Schema.Unknown,
  digest: Schema.String,
}) {}

export const digestOne = (def: EventDef): string => {
  const ast = JSON.stringify((def.payload as unknown as { ast: unknown }).ast ?? null)
  return hex(`${def.type}|${def.version ?? 1}|${ast}`)
}

export interface EventRegistryShape {
  readonly register:    (def: EventDef) => Effect.Effect<void, DuplicateEventType>
  readonly registerAll: (
    defs: ReadonlyArray<EventDef>,
    opts?: { readonly swallowDuplicates?: boolean },
  ) => Effect.Effect<void, DuplicateEventType>
  readonly lookup:   (type: string)  => Effect.Effect<EventDef, UnknownEventType>
  readonly all:      Effect.Effect<ReadonlyArray<EventDef>>
  readonly digest:   Effect.Effect<string>
  readonly wire:     Effect.Effect<ReadonlyArray<EventDefWire>>
}

export class EventRegistry extends Context.Tag("rxweave/EventRegistry")<
  EventRegistry,
  EventRegistryShape
>() {
  static Live = Layer.effect(
    EventRegistry,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<string, EventDef>>(new Map())
      // Memoize the computed digest — otherwise `digest` recomputes
      // O(N log N) hash+sort on every read (e.g. every CloudStore.append).
      // Invalidated inside `register` so the cache is always consistent
      // with the underlying map.
      const cachedDigest = yield* Ref.make<Option.Option<string>>(Option.none())
      const register: EventRegistryShape["register"] = (def) =>
        Ref.get(store).pipe(
          Effect.flatMap((map) => {
            if (map.has(def.type)) {
              return Effect.fail(new DuplicateEventType({ type: def.type }))
            }
            return Ref.set(store, new Map(map).set(def.type, def)).pipe(
              Effect.zipRight(Ref.set(cachedDigest, Option.none())),
            )
          }),
        )
      const registerAll: EventRegistryShape["registerAll"] = (defs, opts) =>
        Effect.forEach(defs, (def) =>
          register(def).pipe(
            Effect.catchTag("DuplicateEventType", (err) => {
              if (opts?.swallowDuplicates !== true) return Effect.fail(err)
              // Swallow only when the existing def has the same digest;
              // a digest mismatch is a genuine schema conflict — always error.
              return Ref.get(store).pipe(
                Effect.flatMap((map) => {
                  const existing = map.get(def.type)
                  if (existing !== undefined && digestOne(existing) === digestOne(def)) {
                    return Effect.void
                  }
                  return Effect.fail(err)
                }),
              )
            }),
          ),
        ).pipe(Effect.asVoid)
      const lookup: EventRegistryShape["lookup"] = (type) =>
        Ref.get(store).pipe(
          Effect.flatMap((map) => {
            const def = map.get(type)
            return def
              ? Effect.succeed(def)
              : Effect.fail(new UnknownEventType({ type }))
          }),
        )
      const all: EventRegistryShape["all"] = Ref.get(store).pipe(
        Effect.map((map) => Array.from(map.values())),
      )
      const computeDigest: Effect.Effect<string> = Ref.get(store).pipe(
        Effect.map((map) => {
          const parts = Array.from(map.values())
            .map(digestOne)
            .sort()
            .join("|")
          return hex(parts)
        }),
      )
      const digest: EventRegistryShape["digest"] = Ref.get(cachedDigest).pipe(
        Effect.flatMap(
          Option.match({
            onSome: (d) => Effect.succeed(d),
            onNone: () =>
              computeDigest.pipe(
                Effect.tap((d) => Ref.set(cachedDigest, Option.some(d))),
              ),
          }),
        ),
      )
      const wire: EventRegistryShape["wire"] = Ref.get(store).pipe(
        Effect.map((map) =>
          Array.from(map.values()).map(
            (def) =>
              new EventDefWire({
                type: def.type,
                version: def.version ?? 1,
                payloadSchema: (def.payload as unknown as { ast: unknown }).ast ?? null,
                digest: digestOne(def),
              }),
          ),
        ),
      )
      return { register, registerAll, lookup, all, digest, wire }
    }),
  )
}
