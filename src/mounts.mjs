import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { OpenSandboxError } from './client.mjs'
import { isDirectory, pathContains, realpathOrNormalized, textOr } from './util.mjs'

/** Bound the mount table so a long session cannot grow it without limit. */
const MAX_MOUNTS = 64

/**
 * One host directory that crosses into the sandbox, or one host path the
 * harness itself may read through ctx.fs. `writable` describes the container
 * bind mount; trusted read paths are never bind-mounted.
 */
function mountEntry(path, writable, source) {
  return Object.freeze({ path, writable, source })
}

/** Canonicalize one configured or command-supplied host path. */
export function canonicalMountPath(value) {
  const text = textOr(value, '')
  if (text.length === 0) throw new OpenSandboxError('OpenSandbox: a mount path is required')
  const expanded = text === '~' || text.startsWith('~/') ? join(homedir(), text.slice(2)) : text
  if (!isAbsolute(expanded)) {
    throw new OpenSandboxError(`OpenSandbox: mount path must be absolute: ${text}`)
  }
  return realpathOrNormalized(expanded)
}

/** Normalize one path list, preserving order and dropping duplicates. */
function normalizePathList(values, label, { requireDirectory = false } = {}) {
  const result = []
  for (const value of values) {
    let path
    try {
      path = canonicalMountPath(value)
    } catch (error) {
      throw new OpenSandboxError(`OpenSandbox: invalid ${label} path ${JSON.stringify(String(value))}: ${error.message}`)
    }
    if (requireDirectory && !isDirectory(path)) {
      throw new OpenSandboxError(`OpenSandbox: ${label} path ${path} is not an existing directory`)
    }
    if (!result.includes(path)) result.push(path)
  }
  return result
}

/**
 * The host-directory boundary shared by the subprocess world and the
 * filesystem provider.
 *
 * The workspace root plus every configured mount is a container bind mount.
 * `extraWritableMounts` is the host-operator-only escape hatch for a directory
 * that must be writable; everything else configured is read-only. A command
 * cwd must canonicalize inside the session workspace or one of these roots,
 * so a model-supplied absolute path can never make `createSandbox` bind an
 * arbitrary host directory.
 *
 * `workspaceParents` are host directories under which dsh web/host sessions
 * may legitimately open a project. They authorise a session workspace, but
 * they are not themselves mounted and cannot be used as a model `workdir`
 * escape: only the exact session root (or a configured mount) becomes a bind
 * mount. `trustedReadPaths` are additional host paths ctx.fs may read for
 * harness-owned features (skills, user instructions) but they are never
 * mounted into a container and are never writable. `protectedPaths` name host
 * credential/control trees that must stay invisible unless a trusted read path
 * explicitly covers them or a configured read-only mount exposes them.
 */
export class MountPolicy {
  constructor({
    workspaceRoot,
    readOnlyMounts = [],
    writableMounts = [],
    trustedReadPaths = [],
    workspaceParents = [],
    protectedPaths = [],
    allowDynamic = true,
  } = {}) {
    this.workspaceRoot = canonicalMountPath(workspaceRoot)
    this.allowDynamic = allowDynamic !== false
    this.mounts = new Map()
    this.trustedReadPaths = []
    this.workspaceParents = normalizePathList(workspaceParents, 'workspace parent', { requireDirectory: true })
    this.protectedPaths = normalizePathList(protectedPaths, 'protected')
    this.mounts.set(this.workspaceRoot, mountEntry(this.workspaceRoot, true, 'workspace'))
    for (const value of readOnlyMounts) this.addConfiguredMount(value, false)
    for (const value of writableMounts) this.addConfiguredMount(value, true)
    for (const value of trustedReadPaths) this.addTrustedReadPath(value)
    this.assertNoMountOverlap()
  }

  /** Add a configured mount, ignoring a non-directory the way the loader does. */
  addConfiguredMount(value, writable) {
    const path = canonicalMountPath(value)
    if (!isDirectory(path)) return
    const existing = this.mounts.get(path)
    if (existing !== undefined) {
      if (existing.writable !== writable) {
        throw new OpenSandboxError(`OpenSandbox: ${path} is configured both read-only and read-write`)
      }
      return
    }
    this.mounts.set(path, mountEntry(path, writable, 'config'))
  }

  /** Allow ctx.fs reads under one host path without exposing it to containers. */
  addTrustedReadPath(value) {
    const path = canonicalMountPath(value)
    if (!this.trustedReadPaths.includes(path)) this.trustedReadPaths.push(path)
  }

  /** Reject overlapping bind mounts so one cannot shadow another's mode. */
  assertNoMountOverlap() {
    const entries = [...this.mounts.values()]
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const a = entries[left]
        const b = entries[right]
        if (a.path === b.path) continue
        if (pathContains(a.path, b.path) || pathContains(b.path, a.path)) {
          throw new OpenSandboxError(
            `OpenSandbox: mount roots overlap (${a.path} and ${b.path}); remove one so each host path has exactly one access mode`,
          )
        }
      }
    }
  }

  /** The narrowest bind mount containing `path`, or undefined. */
  rootFor(path) {
    const canonical = realpathOrNormalized(path)
    let best
    for (const entry of this.mounts.values()) {
      if (!pathContains(entry.path, canonical)) continue
      if (best === undefined || entry.path.length > best.path.length) best = entry
    }
    return best
  }

  /** True when `path` is under a protected host tree. */
  isProtected(path) {
    const canonical = realpathOrNormalized(path)
    return this.protectedPaths.some((protectedPath) => pathContains(protectedPath, canonical))
  }

  /** True when a session may use `path` as its immutable workspace root. */
  isAllowedSessionRoot(path) {
    const canonical = realpathOrNormalized(path)
    if (pathContains(this.workspaceRoot, canonical)) return true
    return this.workspaceParents.some((parent) => pathContains(parent, canonical))
  }

  /** Canonical session root, validated before it can authorise mounts/writes. */
  assertMountableSessionRoot(value) {
    const path = canonicalMountPath(value)
    if (!isDirectory(path)) {
      throw new OpenSandboxError(`OpenSandbox: session workspace ${path} is not an existing host directory`)
    }
    if (!this.isAllowedSessionRoot(path)) {
      const allowed = [this.workspaceRoot, ...this.workspaceParents].join(', ')
      throw new OpenSandboxError(
        `OpenSandbox: session workspace ${path} is outside the configured workspace roots (${allowed}); ` +
          'ask the human to add it to workspaceParents before starting the session',
      )
    }
    if (this.isProtected(path)) {
      throw new OpenSandboxError(`OpenSandbox: refusing to use protected host path ${path} as a session workspace`)
    }
    for (const protectedPath of this.protectedPaths) {
      if (protectedPath !== path && pathContains(path, protectedPath)) {
        throw new OpenSandboxError(
          `OpenSandbox: session workspace ${path} contains protected host path ${protectedPath}; choose a narrower workspace`,
        )
      }
    }
    for (const entry of this.mounts.values()) {
      if (entry.path === path) continue
      if (pathContains(path, entry.path)) {
        throw new OpenSandboxError(
          `OpenSandbox: session workspace ${path} contains configured mount ${entry.path}; choose a narrower workspace`,
        )
      }
    }
    return path
  }

  /**
   * Resolve one command cwd against the session workspace and configured
   * mounts. The model may choose a cwd inside the session workspace or inside
   * an operator-configured mount; it can never turn an arbitrary parent (or
   * sibling project) into a bind mount.
   */
  resolveMount(cwd, sessionRoot) {
    const session = this.assertMountableSessionRoot(sessionRoot ?? this.workspaceRoot)
    const path = realpathOrNormalized(cwd)
    if (!pathContains(session, path)) {
      const global = this.rootFor(path)
      if (global === undefined) {
        throw new OpenSandboxError(
          `OpenSandbox: command cwd ${cwd} is outside the session workspace ${session} and every configured mount root; ` +
            'run /directory-add <host-path> [ro|rw] to scope another host directory into this session',
        )
      }
      return { key: `${global.path}\u0000${session}`, root: global.path, sessionRoot: session }
    }
    const global = this.rootFor(path)
    if (global !== undefined && !pathContains(global.path, session)) {
      return { key: global.path, root: global.path, sessionRoot: session }
    }
    return { key: session, root: session, sessionRoot: session }
  }

  /** Compatibility helper: the bind-mount root for one command cwd. */
  resolveRoot(cwd, sessionRoot) {
    return this.resolveMount(cwd, sessionRoot).root
  }

  /** True when ctx.fs may read `path` in the given session context. */
  isReadable(path, { sessionRoot, allowParents = false } = {}) {
    const canonical = realpathOrNormalized(path)
    if (this.trustedReadPaths.some((trusted) => pathContains(trusted, canonical))) return true
    const global = this.rootFor(canonical)
    if (this.isProtected(canonical)) {
      // A protected path is readable only when an operator configured a
      // read-only mount whose root is itself that protected path (for
      // example /nix/store, or an explicit host-access credential mount).
      // A broad mount that merely contains the protected path does not
      // reopen it.
      return global !== undefined && this.isProtected(global.path)
    }
    if (global !== undefined) return true
    if (sessionRoot !== undefined) {
      try {
        if (pathContains(this.assertMountableSessionRoot(sessionRoot), canonical)) return true
      } catch {
        // An invalid session root contributes no read authority.
      }
    }
    if (allowParents) return this.workspaceParents.some((parent) => pathContains(parent, canonical))
    return false
  }

  /** True when ctx.fs may write `path` in the given session context. */
  isWritable(path, { sessionRoot, mode } = {}) {
    if (mode === 'read-only') return false
    const canonical = realpathOrNormalized(path)
    // Credential/control paths never become writable through ctx.fs,
    // including a session workspace nested under one.
    if (this.isProtected(canonical)) return false
    const global = this.rootFor(canonical)
    if (global !== undefined) return global.writable
    if (sessionRoot === undefined) return false
    try {
      const session = this.assertMountableSessionRoot(sessionRoot)
      return pathContains(session, canonical)
    } catch {
      return false
    }
  }

  /**
   * Resolve a model-supplied path for lstat-style checks without following the
   * final component. The parent chain is canonicalized, so an intermediate
   * symlink out of a mount cannot smuggle a path past the fence.
   */
  visiblePathForHostPath(rawPath, cwd = this.workspaceRoot, options = {}) {
    const text = textOr(rawPath, '')
    if (text.length === 0) return undefined
    const absolute = normalize(resolve(cwd, text))
    const parent = dirname(absolute)
    const canonicalParent = realpathOrNormalized(parent)
    const candidate = canonicalParent === parent ? absolute : join(canonicalParent, basename(absolute))
    return this.isReadable(candidate, options) ? candidate : undefined
  }

  /** Readable mounts, workspace parents, and trusted host paths, for diagnostics. */
  describe() {
    return this.describeMounts().concat(
      this.workspaceParents.map((path) => ({ path, mode: 'ro', source: 'workspace-parent' })),
      this.trustedReadPaths.map((path) => ({ path, mode: 'ro', source: 'trusted-read' })),
    )
  }

  /** Container bind mounts in stable order. */
  describeMounts() {
    const entries = [...this.mounts.values()].sort((left, right) => {
      if (left.path === this.workspaceRoot) return -1
      if (right.path === this.workspaceRoot) return 1
      return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    })
    return entries.map((entry) => ({
      path: entry.path,
      mode: entry.writable ? 'rw' : 'ro',
      source: entry.source,
    }))
  }

  /** Build the OpenSandbox volume list for one sandbox target. */
  volumesFor(rootPath, sessionRoot) {
    const entries = new Map(this.mounts)
    if (sessionRoot !== undefined) {
      const session = this.assertMountableSessionRoot(sessionRoot)
      if (!entries.has(session)) {
        const overlaps = [...entries.values()].some(
          (entry) => pathContains(entry.path, session) || pathContains(session, entry.path),
        )
        if (!overlaps) entries.set(session, mountEntry(session, true, 'session'))
      }
    }
    const sorted = [...entries.values()].sort((left, right) => {
      if (left.path === rootPath) return -1
      if (right.path === rootPath) return 1
      if (left.path === this.workspaceRoot) return -1
      if (right.path === this.workspaceRoot) return 1
      return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    })
    return sorted.map((entry, index) => ({
      name: `mnt${index}`,
      host: { path: entry.path },
      mountPath: entry.path,
      ...(entry.writable ? {} : { readOnly: true }),
    }))
  }

  /** Add one human-scoped dynamic mount and report the effective mode. */
  addDynamic(rawPath, access) {
    if (!this.allowDynamic) {
      throw new OpenSandboxError('OpenSandbox: dynamic directory mounts are disabled in this profile')
    }
    const writable = access === 'rw'
    const path = canonicalMountPath(rawPath)
    if (path === '/') {
      throw new OpenSandboxError('OpenSandbox: refusing to mount the host root directory')
    }
    const existing = this.rootFor(path)
    if (existing !== undefined) {
      if (existing.source === 'dynamic' && existing.path === path) {
        if (existing.writable !== writable) {
          throw new OpenSandboxError(
            `OpenSandbox: ${path} is already mounted ${existing.writable ? 'read-write' : 'read-only'}; remove it before changing the mode`,
          )
        }
        return { path, mode: existing.writable ? 'rw' : 'ro', changed: false }
      }
      throw new OpenSandboxError(
        `OpenSandbox: ${path} is already visible through the ${existing.writable ? 'read-write' : 'read-only'} mount ${existing.path}`,
      )
    }
    if (!isDirectory(path)) {
      throw new OpenSandboxError(`OpenSandbox: ${path} is not an existing host directory`)
    }
    if (this.mounts.size >= MAX_MOUNTS) {
      throw new OpenSandboxError(`OpenSandbox: refusing to add more than ${MAX_MOUNTS} mounts`)
    }
    for (const entry of this.mounts.values()) {
      if (pathContains(entry.path, path) || pathContains(path, entry.path)) {
        throw new OpenSandboxError(
          `OpenSandbox: ${path} overlaps the existing mount ${entry.path}; overlapping bind mounts are not allowed`,
        )
      }
    }
    this.mounts.set(path, mountEntry(path, writable, 'dynamic'))
    return { path, mode: writable ? 'rw' : 'ro', changed: true }
  }

  /** Remove one dynamic mount. Configured mounts are not mutable at runtime. */
  removeDynamic(rawPath) {
    const path = canonicalMountPath(rawPath)
    const entry = this.mounts.get(path)
    if (entry === undefined) {
      throw new OpenSandboxError(`OpenSandbox: ${path} is not a mounted directory`)
    }
    if (entry.source !== 'dynamic') {
      throw new OpenSandboxError(
        `OpenSandbox: ${path} comes from the dsh profile configuration; edit that file to remove it`,
      )
    }
    this.mounts.delete(path)
    return { path, mode: entry.writable ? 'rw' : 'ro' }
  }
}
