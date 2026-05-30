# RxWeave examples

Runnable example projects, committed so you can read them on GitHub without
running anything. Each is the verbatim output of an `rxweave init` template
(kept in sync with the CLI by a test in `@rxweave/cli`), plus a `package.json`
so you can `bun install` and run it.

- **`collaboration-stream/`** — the output of `rxweave init --template full`.
  A human posts `request.posted` via the CLI; a coworker's agent
  (`bob-assistant`) reacts with `response.posted` on the same shared log, with
  full `actor` / `causedBy` provenance. See its `README.md` to run it, and
  `docs/cookbook/llm-agent.md` to swap the stub for a real Claude agent.

To run one:

```bash
cd examples/collaboration-stream
bun install
bunx rxweave dev &
bunx rxweave emit request.posted --actor alice --payload '{"text":"hello"}'
bunx rxweave stream
```
