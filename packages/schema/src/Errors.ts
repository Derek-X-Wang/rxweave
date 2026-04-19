import { Schema } from "effect"
import { EventId } from "./Ids.js"

export class UnknownEventType extends Schema.TaggedError<UnknownEventType>()(
  "UnknownEventType",
  { type: Schema.String },
) {}

export class DuplicateEventType extends Schema.TaggedError<DuplicateEventType>()(
  "DuplicateEventType",
  { type: Schema.String },
) {}

export class SchemaValidation extends Schema.TaggedError<SchemaValidation>()(
  "SchemaValidation",
  { type: Schema.String, issue: Schema.Unknown },
) {}

export class RegistryOutOfDate extends Schema.TaggedError<RegistryOutOfDate>()(
  "RegistryOutOfDate",
  { missingTypes: Schema.Array(Schema.String) },
) {}

export class DanglingLineage extends Schema.TaggedError<DanglingLineage>()(
  "DanglingLineage",
  { eventId: EventId, missingAncestor: EventId },
) {}

export class InvalidAgentDef extends Schema.TaggedError<InvalidAgentDef>()(
  "InvalidAgentDef",
  { agentId: Schema.String, reason: Schema.String },
) {}
