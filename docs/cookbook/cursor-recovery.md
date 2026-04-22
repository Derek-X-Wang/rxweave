# Cookbook: Resume an agent after crash

An agent checkpoints the current stream head. On restart, it resumes
from that cursor — no gaps, no duplicates.

```bash
# 1. Save a checkpoint before starting work.
mkdir -p .agent
cursor=$(rxweave cursor)
printf '%s\n' "$cursor" > .agent/checkpoint

# 2. Emit events, make decisions, write side-effects…
rxweave emit my.event.type --payload '{"ok":true}'

# 3. Agent crashes. On restart, resume from the saved cursor.
#    An empty checkpoint file means the store was empty when we
#    started — fall back to following from the beginning.
cursor=$(cat .agent/checkpoint)
if [ -z "$cursor" ]; then
  rxweave stream --follow | my-agent
else
  rxweave stream --follow --from-cursor "$cursor" | my-agent
fi
```

`rxweave cursor` prints the current head event id on stdout as a
single token (or an empty line when the store is empty). Pipe it to a
file, env var, or any durable medium your agent controls.

## Guarantees

- `stream --from-cursor <cursor>` returns events **strictly after** the
  cursor. The cursor itself is not re-delivered.
- Order is preserved — events arrive in the same order the store
  appended them.
- Events that landed while the agent was down are delivered in one
  contiguous run once `--follow` subscribes.

## Caveats

- If the **server** was also down during the outage, events that
  weren't accepted during that window were never recorded — nothing
  to recover. Use `rxweave serve` under a process supervisor (systemd,
  launchd, pm2) to keep the stream online.
- Cursors are **stream-scoped**. A cursor from one stream file is not
  meaningful against another — the ULID space is per-store.
- The empty-line return from `rxweave cursor` (for an empty store) is
  load-bearing: downstream shell branches should use `[ -z "$cursor" ]`
  rather than comparing against the literal string `earliest`.

## Using `AgentCursorStore` instead of a file

If your agent runs inside `@rxweave/runtime`'s `supervise([...])`
harness, you don't need to manage the checkpoint file yourself —
`AgentCursorStore` tracks each agent's position as a side-effect of
processing. Inspect it from the CLI:

```bash
rxweave agent list            # cursors for all agents
rxweave agent status <id>     # { agentId, cursor, fiberStatus }
```

`AgentCursorStore.Memory` is ephemeral (resets on process restart).
Pass `AgentCursorStore.File({ path: ".rxweave/cursors.json" })` when
building the runtime layer for crash-durable checkpoints — it
`fsync`s on every `set()` so a hard kill preserves the last-saved
cursor. The shell pattern above is still useful for agents that run
outside `supervise([...])`.
