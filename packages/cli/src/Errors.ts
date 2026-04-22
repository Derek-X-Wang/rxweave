export const exitCodeFor = (tag: string): number => {
  switch (tag) {
    case "UnknownEventType":
    case "NotFound":
    case "NotFoundWireError":
      return 2
    case "SchemaValidation":
    case "DuplicateEventType":
    // Bad CLI arguments share the schema-invalid category — the user
    // gave us something structurally wrong.
    case "InvalidStreamOptions":
    case "UnknownFold":
    case "UnsafeServerConfig":
      return 3
    case "AppendError":
    case "SubscribeError":
    case "QueryError":
    case "SubscriberLagged":
      return 4
    case "RegistryOutOfDate":
      return 6
    case "InvalidAgentDef":
      return 1
    default:
      return 1
  }
}

export const tagOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = (error as { _tag: unknown })._tag
    if (typeof tag === "string") return tag
  }
  return "UnknownError"
}

export type ErrorPayload = { readonly _tag: string } & Record<string, unknown>

export const toErrorPayload = (error: unknown): ErrorPayload => {
  if (typeof error === "object" && error !== null) {
    // Every Schema.TaggedError extends Inspectable and ships a toJSON() that
    // returns { _tag, ...fields } without Bun's debug noise. Use it when
    // available; fall back to a plain-object copy for raw Errors (e.g. the
    // Error returned from loadConfig's tryPromise catch handler).
    const maybeToJson = (error as { toJSON?: () => unknown }).toJSON
    if (typeof maybeToJson === "function") {
      const json = maybeToJson.call(error) as Record<string, unknown>
      if (typeof json._tag !== "string") return { ...json, _tag: "UnknownError" }
      return json as ErrorPayload
    }
    // Plain object with a string `_tag` — use it directly. Lets CLI
    // command handlers `Effect.fail({_tag, ...})` without constructing
    // a full Schema.TaggedError class for single-site arg-shape errors.
    const asRecord = error as Record<string, unknown>
    if (typeof asRecord._tag === "string") return asRecord as ErrorPayload
    const plain: Record<string, unknown> = {}
    if (error instanceof Error && typeof error.message === "string") {
      plain.message = error.message
    }
    return { ...plain, _tag: "UnknownError" }
  }
  return { _tag: "UnknownError", message: String(error) }
}
