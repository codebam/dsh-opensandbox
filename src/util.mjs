import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

/** Return the first non-empty trimmed string, else the fallback. */
export function textOr(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/** Expand a leading `~` without touching the rest of the path. */
export function expandHome(value) {
  const text = textOr(value, '')
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

/** True when `child` is `parent` or a descendant of it, after normalization. */
export function pathContains(parent, child) {
  const p = normalize(resolve(parent))
  const c = normalize(resolve(child))
  return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`)
}

/** Realpath when the path exists; the normalized absolute path otherwise. */
export function realpathOrNormalized(path) {
  const absolute = resolve(expandHome(path))
  try {
    return realpathSync(absolute)
  } catch {
    return normalize(absolute)
  }
}

/** True when the path exists and is a directory. */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** True when the path exists. */
export function pathExists(path) {
  return existsSync(path)
}

/** Quote one argv element for `sh -c` (POSIX single-quote form). */
export function shellQuote(value) {
  const text = String(value)
  if (text.length === 0) return "''"
  return `'${text.replaceAll("'", `'\\''`)}'`
}

/** Build a shell command string from an argv array. */
export function shellJoin(argv) {
  return argv.map(shellQuote).join(' ')
}

/** Resolve a sandbox path for the host filesystem (absolute only). */
export function absoluteHostPath(path, cwd = process.cwd()) {
  const expanded = expandHome(path)
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
  return normalize(absolute)
}

/** Promise-based sleep. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One-line description of an unknown error. */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
