import { Clock, Effect, Schema, Stream } from "effect"
import { ActorId, EventEnvelope, SchemaValidation, Source } from "@rxweave/schema"
import { matchAny } from "./Glob.js"

export const whereType = (glob: string | ReadonlyArray<string>) =>
  <E>(s: Stream.Stream<EventEnvelope, E>) =>
    Stream.filter(s, (e) => matchAny(e.type, glob))

export const byActor = (actor: ActorId | ReadonlyArray<ActorId>) =>
  <E>(s: Stream.Stream<EventEnvelope, E>) => {
    const arr = Array.isArray(actor) ? (actor as ReadonlyArray<ActorId>) : [actor as ActorId]
    return Stream.filter(s, (e) => arr.includes(e.actor))
  }

export const bySource = (source: Source | ReadonlyArray<Source>) =>
  <E>(s: Stream.Stream<EventEnvelope, E>) => {
    const arr = Array.isArray(source) ? (source as ReadonlyArray<Source>) : [source as Source]
    return Stream.filter(s, (e) => arr.includes(e.source))
  }

export const withinWindow = (ms: number) =>
  <E>(s: Stream.Stream<EventEnvelope, E>) =>
    Stream.filterEffect(s, (e) =>
      Clock.currentTimeMillis.pipe(Effect.map((now) => now - e.timestamp <= ms)),
    )

export const decodeAs = <A, I>(schema: Schema.Schema<A, I>) =>
  <E>(s: Stream.Stream<EventEnvelope, E>): Stream.Stream<A, E | SchemaValidation> =>
    Stream.mapEffect(s, (e) =>
      Schema.decodeUnknown(schema)(e.payload).pipe(
        Effect.mapError((issue) => new SchemaValidation({ type: e.type, issue })),
      ),
    )
