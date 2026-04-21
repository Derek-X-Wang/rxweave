import { canvasFold } from "./canvas.js"

/**
 * Registry of built-in folds available via `rxweave stream --fold <name>`.
 * User-defined folds from `.ts` files (`--fold ./my-fold.ts`) are a
 * non-goal for v1 — they require dynamic `import()` of untrusted code
 * and a stable public surface for the fold shape. For now this map is
 * the only thing `--fold` can resolve.
 */
export const BUILTIN_FOLDS = {
  canvas: canvasFold,
} as const

export type BuiltinFoldName = keyof typeof BUILTIN_FOLDS

export const isBuiltinFoldName = (s: string): s is BuiltinFoldName =>
  Object.prototype.hasOwnProperty.call(BUILTIN_FOLDS, s)
