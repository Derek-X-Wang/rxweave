import { Context, Effect, Layer, Ref, Clock, Random } from "effect"
import type { EventId } from "./Ids.js"

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

const encodeTime = (ms: number): string => {
  let remaining = Math.floor(ms)
  const out = new Array<string>(10)
  for (let i = 9; i >= 0; i--) {
    out[i] = ALPHABET[remaining % 32]!
    remaining = Math.floor(remaining / 32)
  }
  return out.join("")
}

const encodeRandom = (bytes: Uint8Array): string => {
  let bits = 0
  let buf = 0
  const out: Array<string> = []
  for (const byte of bytes) {
    buf = (buf << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push(ALPHABET[(buf >> bits) & 31]!)
    }
  }
  return out.join("").slice(0, 16)
}

export interface UlidShape {
  readonly next: Effect.Effect<EventId>
}

export class Ulid extends Context.Tag("rxweave/Ulid")<Ulid, UlidShape>() {
  static Live = Layer.effect(
    Ulid,
    Effect.gen(function* () {
      const last = yield* Ref.make(0)
      return {
        next: Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const clamped = yield* Ref.modify(last, (prev) => {
            const next = Math.max(prev + 1, now)
            return [next, next]
          })
          const rand = new Uint8Array(10)
          for (let i = 0; i < rand.length; i++) {
            rand[i] = yield* Random.nextIntBetween(0, 256)
          }
          return (encodeTime(clamped) + encodeRandom(rand)) as EventId
        }),
      }
    }),
  )
}
