#!/usr/bin/env bash
# Proves the README quickstart works for an outside user, from a fresh dir.
#
# HOW THE INSTALL WORKS (known-hard part — read before modifying):
#
# The new `--template full` exists ONLY in the LOCAL cli build (rxweave-bin),
# not on npm 0.5.4. The runtime deps imported by the scaffold
# (@rxweave/schema, @rxweave/store-file, @rxweave/runtime) ARE on npm 0.5.4.
#
# Two bugs were found in the 0.5.4 npm packages that are fixed locally:
# 1. FilterOptions.ts: `Options.repeated.pipe(Options.optional)` returns
#    `Some([])` instead of `None` in @effect/cli 0.75.0, causing `stream`
#    to always return 0 events. Fix: guard `length > 0` before setting filter.
# 2. FileStore.ts: in-memory PubSub only; separate-process `emit` events
#    were invisible to `dev`'s agent. Fix: 200ms file-tail background fiber
#    detects and injects new lines written by other processes.
#
# Working approach:
#   - Install runtime deps from npm@0.5.4 (clean module resolution, no
#     workspace:^ issues)
#   - Replace @rxweave/cli/dist and @rxweave/store-file/dist with the
#     LOCAL builds (which include the two fixes above)
#   - Use the LOCAL rxweave-bin ONLY for `init --template full` (binary has
#     the new template; binary can't do dynamic config imports, but init
#     doesn't need that)
#   - Use node_modules/.bin/rxweave (symlink → local dist in node_modules)
#     for dev/emit/stream/inspect — this runs the fixed local dist but
#     resolves ALL deps from the project's single node_modules tree
#     (no Effect-version conflicts)
#
# To test post-release against a fully-published version, set:
#   RXWEAVE_SCHEMA_SPEC=@rxweave/schema@X.Y.Z
#   RXWEAVE_STORE_FILE_SPEC=@rxweave/store-file@X.Y.Z
#   RXWEAVE_RUNTIME_SPEC=@rxweave/runtime@X.Y.Z
#   RXWEAVE_CLI_SPEC=@rxweave/cli@X.Y.Z
#   RXWEAVE_INIT_CMD="bun x rxweave"   # use npm cli for init too
# and remove the dist-override step once the bug fixes are released.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
cleanup() {
  [ -n "${DEV_PID:-}" ] && kill "$DEV_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

cd "$WORK"
echo '{ "name": "smoke", "type": "module", "private": true }' > package.json

# --- install ---
# Install runtime deps from npm; the CLI is installed too so the symlink
# node_modules/.bin/rxweave exists and points into @rxweave/cli/dist/bin/.
SCHEMA_SPEC="${RXWEAVE_SCHEMA_SPEC:-@rxweave/schema@0.5.4}"
STORE_FILE_SPEC="${RXWEAVE_STORE_FILE_SPEC:-@rxweave/store-file@0.5.4}"
RUNTIME_SPEC="${RXWEAVE_RUNTIME_SPEC:-@rxweave/runtime@0.5.4}"
CLI_SPEC="${RXWEAVE_CLI_SPEC:-@rxweave/cli@0.5.4}"

bun add "$SCHEMA_SPEC" "$STORE_FILE_SPEC" "$RUNTIME_SPEC" "$CLI_SPEC" effect

# Replace the npm CLI dist + store-file dist with local builds that include
# the two bugfixes (stream filter + FileStore cross-process tail).
# Skip this block when RXWEAVE_USE_NPM_DIST=1 (post-release testing).
if [ "${RXWEAVE_USE_NPM_DIST:-0}" != "1" ]; then
  echo "Applying local dist overrides (stream-filter + file-tail fixes)..."
  cp -r "$REPO/packages/cli/dist/"        "$WORK/node_modules/@rxweave/cli/dist/"
  cp -r "$REPO/packages/store-file/dist/" "$WORK/node_modules/@rxweave/store-file/dist/"
fi

# CLI wrappers:
# RX_INIT: uses the LOCAL binary for `init --template full` (new template).
# RX: uses the npm-symlinked CLI in node_modules (single dep-tree, fixed dists).
RX_INIT="${RXWEAVE_INIT_CMD:-$REPO/rxweave-bin}"
RX() { "$WORK/node_modules/.bin/rxweave" "$@"; }
# Extract the `.id` field from a single JSON envelope line.
extract_id() { printf '%s' "$1" | bun -e 'process.stdin.once("data",d=>process.stdout.write(JSON.parse(d.toString()).id))'; }
# --- end install ---

"$RX_INIT" init --template full
test -f rxweave.config.ts && test -f schemas.ts && test -f agents/bob-assistant.ts
echo "Scaffold files OK"

RX dev > dev.log 2>&1 &
DEV_PID=$!
for i in $(seq 1 50); do grep -q '"kind":"dev-ready"' dev.log && break; sleep 0.2; done
grep -q '"kind":"dev-ready"' dev.log || { echo "dev never ready"; cat dev.log; exit 1; }
echo "dev ready"

REQ_JSON="$(RX emit request.posted --actor alice --payload '{"text":"urgent: ship it"}')"
REQ_ID="$(extract_id "$REQ_JSON")"
[ -n "$REQ_ID" ] || { echo "no request id: $REQ_JSON"; exit 1; }
echo "emitted request $REQ_ID"

# Poll for the response.posted event. The file-tail fiber (200ms interval)
# injects new events from the emit process; the agent processes them and
# writes the response. Allow up to 10s for the full round-trip.
for i in $(seq 1 50); do
  STREAM="$(RX stream --last 100)"
  RESP="$(printf '%s\n' "$STREAM" | grep '"type":"response.posted"' | tail -1)"
  [ -n "$RESP" ] && break
  sleep 0.2
done
[ -n "$RESP" ] || { echo "no response.posted after 10s"; echo "$STREAM"; exit 1; }

printf '%s' "$RESP" | bun -e '
  const e = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const reqId = process.argv[1];
  if (e.actor !== "bob-assistant") { console.error("actor:", e.actor); process.exit(1); }
  if (!Array.isArray(e.causedBy) || !e.causedBy.includes(reqId)) {
    console.error("causedBy:", e.causedBy); process.exit(1);
  }
  if (e.payload.requestId !== reqId) {
    console.error("payload.requestId:", e.payload.requestId); process.exit(1);
  }
  console.error("OK response", e.id, "caused by", reqId);
' "$REQ_ID"

RESP_ID="$(extract_id "$RESP")"
RX inspect "$RESP_ID" --ancestry | grep -q "$REQ_ID" || { echo "ancestry missing request"; exit 1; }

echo "SMOKE OK"
