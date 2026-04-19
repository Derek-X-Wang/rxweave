import { Context, Effect, Layer, Ref, Schema } from "effect"
import { createHash } from "node:crypto"
import { DuplicateEventType, UnknownEventType } from "./Errors.js"

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

const digestOne = (def: EventDef): string => {
  const ast = JSON.stringify((def.payload as unknown as { ast: unknown }).ast ?? null)
  return createHash("sha256")
    .update(`${def.type}|${def.version ?? 1}|${ast}`)
    .digest("hex")
}

export interface EventRegistryShape {
  readonly register: (def: EventDef) => Effect.Effect<void, DuplicateEventType>
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
      const register: EventRegistryShape["register"] = (def) =>
        Ref.get(store).pipe(
          Effect.flatMap((map) => {
            if (map.has(def.type)) {
              return Effect.fail(new DuplicateEventType({ type: def.type }))
            }
            return Ref.set(store, new Map(map).set(def.type, def))
          }),
        )
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
      const digest: EventRegistryShape["digest"] = Ref.get(store).pipe(
        Effect.map((map) => {
          const parts = Array.from(map.values())
            .map(digestOne)
            .sort()
            .join("|")
          return createHash("sha256").update(parts).digest("hex")
        }),
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
      return { register, lookup, all, digest, wire }
    }),
  )
}
