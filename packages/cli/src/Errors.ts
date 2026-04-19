export const exitCodeFor = (tag: string): number => {
  switch (tag) {
    case "UnknownEventType":
    case "NotFound":
    case "NotFoundWireError":
      return 2
    case "SchemaValidation":
    case "DuplicateEventType":
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

const NOISE_KEYS = new Set([
  "stack",
  "originalLine",
  "originalColumn",
  "line",
  "column",
  "sourceURL",
])

export const toErrorPayload = (error: unknown): Record<string, unknown> => {
  if (typeof error === "object" && error !== null) {
    const plain: Record<string, unknown> = {}
    for (const key of Object.getOwnPropertyNames(error)) {
      if (NOISE_KEYS.has(key)) continue
      plain[key] = (error as Record<string, unknown>)[key]
    }
    if (!("_tag" in plain)) plain._tag = "UnknownError"
    return plain
  }
  return { _tag: "UnknownError", message: String(error) }
}
