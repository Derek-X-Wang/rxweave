# @rxweave/dev playground

Three example agents that demonstrate rxweave primitives:

- `counter` — pure reduce, emits `counter.tick` with running total.
- `echo` — side-effectful handle wrapped in `withIdempotence("local")`.
- `task-from-speech` — semantic derivation: turns `speech.transcribed` into `task.created` when trigger words appear.

## Try it

```bash
bun install
bun run dev            # starts supervise() under rxweave dev; tails events

# in another pane:
rxweave emit canvas.node.created --payload '{"id":"n1","label":"Hello"}'
rxweave emit speech.transcribed --payload '{"text":"todo: buy milk","confidence":0.9}'
rxweave stream --follow
```
