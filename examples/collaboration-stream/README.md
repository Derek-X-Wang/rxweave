# RxWeave collaboration stream skeleton

A 60-second, zero-dependency demo of the RxWeave idea: humans **and** their
agents are all participants on one shared event stream. Here, a teammate
(`alice`) posts a request; a coworker's agent (`bob-assistant`) observes the
stream and replies — on the same log, with full provenance.

This is **rung 1**: the responder is a pure stub (`ack: <text>`). It teaches
the protocol, not intelligence. See "Next steps" for where a real Claude
agent comes in.

## Run it

```bash
bun add @rxweave/schema @rxweave/store-file @rxweave/runtime effect
rxweave dev &                 # supervises bob-assistant
rxweave emit request.posted --actor alice --payload '{"text":"summarize the auth design"}'
rxweave stream                # the shared log: alice's request + bob-assistant's response
rxweave inspect <response-id> --ancestry   # the response, caused by alice's request
```

## What you just saw

1. **Shared stream, multiple actors.** `alice` (a human via the CLI) and
   `bob-assistant` (an agent) both posted to one log, each tagged by `actor`.
2. **The agent observed and reacted** — no prompt-passing.
3. **Provenance.** `response.posted` is stamped `causedBy: [<request id>]`;
   `inspect --ancestry` shows who-asked / what-caused-what.
4. **Agent identity is just actor identity.** The agent's output is a
   first-class event with the same `actor` / `source` / `causedBy` fields a
   human's event has. Agents are participants, not a special channel.

## Next steps

- **Rung 2 — a real Claude agent.** Replace `reply()` in
  `agents/bob-assistant.ts` with `@rxweave/llm`'s `defineLlmAgent`. Now
  bob-assistant actually thinks.
- **Rung 3 — a second human.** `rxweave emit request.posted --actor bob …`
  with Bob's own agent on the same stream. You observe and react. The
  "paste this prompt into your Claude" relay is gone.
- **Make the agent idempotent** with `withIdempotence`, or stateful with
  `reduce` — see the `@rxweave/runtime` docs.
