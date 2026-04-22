/**
 * Bundle size reporter for apps/web's Vite production build.
 *
 * Walks ./dist/, sums JS + CSS asset sizes, prints both the raw (unzipped)
 * total and a gzipped estimate (each file gzipped independently — not the
 * same as a single concatenated gzip stream, but a reasonable proxy for
 * what a browser pulls over a gzip-enabled CDN).
 *
 * Budget (spec §11): `apps/web`'s production bundle must not grow by more
 * than 200 KB gzipped due to `@rxweave/store-cloud` adoption. The first
 * measurement recorded in the git log serves as the baseline and future
 * growth is measured against it — this script is currently a reporting
 * tool rather than a CI gate.
 *
 * No external deps — node:fs + node:zlib only.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { extname, join, relative } from "node:path"

const DIST = "./dist"
const BUDGET_GZIP_KB = 200

function walk(dir: string): Array<string> {
  const out: Array<string> = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

type Row = {
  readonly path: string
  readonly raw: number
  readonly gz: number
}

const files = walk(DIST)
const jsAndCss = files.filter((f) => [".js", ".css"].includes(extname(f)))

const rows: Array<Row> = []
let totalRaw = 0
let totalGz = 0
for (const f of jsAndCss) {
  const buf = readFileSync(f)
  const raw = buf.length
  const gz = gzipSync(buf).length
  totalRaw += raw
  totalGz += gz
  rows.push({ path: relative(DIST, f), raw, gz })
}

// Sort largest-first so the main chunk leads the table.
rows.sort((a, b) => b.gz - a.gz)

const kb = (n: number) => (n / 1024).toFixed(1) + " KB"

console.log(`[bundle:measure] dist/ contents (JS + CSS only)`)
console.log(`[bundle:measure] ${"path".padEnd(48)} ${"raw".padStart(10)} ${"gzip".padStart(10)}`)
for (const r of rows) {
  console.log(`[bundle:measure] ${r.path.padEnd(48)} ${kb(r.raw).padStart(10)} ${kb(r.gz).padStart(10)}`)
}
console.log(`[bundle:measure] ${"TOTAL".padEnd(48)} ${kb(totalRaw).padStart(10)} ${kb(totalGz).padStart(10)}`)
console.log(`[bundle:measure] files: ${jsAndCss.length}`)
console.log(`[bundle:measure] budget: ${BUDGET_GZIP_KB} KB gzipped growth from pre-Phase-F baseline (spec §11)`)
console.log(`[bundle:measure] note: per-file gzip, not a single-stream gzip — treat as an upper-bound estimate`)
