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
