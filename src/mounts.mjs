import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
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

/**
 * The host-directory boundary shared by the subprocess world and the
 * filesystem provider.
 *
 * The workspace root plus every configured mount is a container bind mount.
 * `extraWritableMounts` is the host-operator-only escape hatch for a directory
 * that must be writable; everything else configured is read-only. A command
 * cwd must canonicalize inside one of these roots, so a model-supplied
 * absolute path can never make `createSandbox` bind an arbitrary host
 * directory. Trusted read paths are additional host paths ctx.fs may read for
 * harness-owned features (skills, user instructions) but they are never
 * mounted into a container and are never writable.
 */
export class MountPolicy {
  constructor({
    workspaceRoot,
    readOnlyMounts = [],
    writableMounts = [],
    trustedReadPaths = [],
    allowDynamic = true,
  } = {}) {
    this.workspaceRoot = canonicalMountPath(workspaceRoot)
    this.allowDynamic = allowDynamic !== false
    this.mounts = new Map()
    this.trustedReadPaths = []
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

  /** True when `path` is a mount root or a descendant of one, after realpath. */
  isVisible(path) {
    const canonical = realpathOrNormalized(path)
    if (this.rootFor(canonical) !== undefined) return true
    return this.trustedReadPaths.some((trusted) => pathContains(trusted, canonical))
  }

  /** True when a bind-mounted root would accept a write at `path`. */
  isWritable(path) {
    return this.rootFor(realpathOrNormalized(path))?.writable === true
  }

  /** The narrowest mount root containing `path`, or undefined. */
  rootFor(path) {
    const canonical = realpathOrNormalized(path)
    let best
    for (const entry of this.mounts.values()) {
      if (!pathContains(entry.path, canonical)) continue
      if (best === undefined || entry.path.length > best.path.length) best = entry
    }
    return best
  }

  /**
   * Resolve a model-supplied path for lstat-style checks without following the
   * final component. The parent chain is canonicalized, so an intermediate
   * symlink out of a mount cannot smuggle a path past the fence.
   */
  visiblePathForHostPath(rawPath, cwd = this.workspaceRoot) {
    const text = textOr(rawPath, '')
    if (text.length === 0) return undefined
    const absolute = normalize(resolve(cwd, text))
    const parent = dirname(absolute)
    const canonicalParent = realpathOrNormalized(parent)
    const candidate = canonicalParent === parent ? absolute : join(canonicalParent, basename(absolute))
    return this.isVisible(candidate) ? candidate : undefined
  }

  /** Readable mounts and trusted host paths, for diagnostics. */
  describe() {
    return this.describeMounts().concat(
      this.trustedReadPaths.map((path) => ({ path, mode: 'ro', source: 'trusted-read' })),
    )
  }

  /** Container bind mounts in stable workspace-first order. */
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

  /** Build the OpenSandbox volume list for a sandbox rooted at `rootPath`. */
  volumesFor(rootPath) {
    const root = this.rootFor(rootPath)
    if (root === undefined) {
      throw new OpenSandboxError(`OpenSandbox: ${rootPath} is not a sandbox mount root`)
    }
    const entries = [...this.mounts.values()].sort((left, right) => {
      if (left.path === this.workspaceRoot) return -1
      if (right.path === this.workspaceRoot) return 1
      return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    })
    return entries.map((entry, index) => ({
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
    if (path === sep || path === '/') {
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
