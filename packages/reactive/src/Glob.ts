import { minimatch } from "minimatch"

export const matchAny = (value: string, globs: string | ReadonlyArray<string>): boolean => {
  const list = typeof globs === "string" ? [globs] : globs
  return list.some((g) => minimatch(value, g))
}
