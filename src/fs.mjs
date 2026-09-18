import { isAbsolute } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { MountPolicy } from './mounts.mjs'
import { pathContains, realpathOrNormalized } from './util.mjs'

const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

/**
 * A host filesystem backend fenced by the same session-workspace and mount
 * table as the container world.
 *
 * dsh's shipped `@deepseek-ai/dsh-fs-sandbox` confines writes but deliberately
 * leaves reads unconfined, because the host filesystem is normally the
 * execution world. This plugin swaps the execution world for an OpenSandbox
 * container, so the host filesystem is no longer the world the model should
 * read: a `read`/`grep`/`read_image` call must not reach outside the paths the
 * sandbox already exposes.
 *
 * The fence follows dsh's own resolve options: model-facing tools pass the
 * session's immutable cwd, so paths resolve relative to and stay inside that
 * session workspace; tools that operate on harness-discovered absolute paths
 * (project-marker and instruction discovery) get read access under the
 * configured `workspaceParents`, still minus protected credential trees.
 * Mutations additionally require the session workspace or a writable mount.
 * Trusted read paths cover harness-owned reads such as user skills and
 * `~/.dsh/AGENTS.md` without exposing those paths to the container.
 *
 * The fence is a trusted-code check over model-controlled paths, matching the
 * `dsh-fs-sandbox` threat model: it closes the host-read escape for the
 * model-facing file tools, not kernel-level containment of arbitrary code
 * (that is the container world's job).
 */
export class OpenSandboxFileSystem extends LocalFileSystem {
  constructor(ctx, config = {}) {
    super(ctx, {
      cwd: config.cwd ?? process.cwd(),
      diffBasisMaxBytes: config.diffBasisMaxBytes ?? DEFAULT_DIFF_BASIS_MAX_BYTES,
    })
    if (!(config.mountPolicy instanceof MountPolicy)) {
      throw new TypeError('OpenSandboxFileSystem: a MountPolicy is required')
    }
    this.mountPolicy = config.mountPolicy
  }

  /**
   * A confining backend fact: dsh-tool-fs advertises escalation and resolves
   * the per-call sandbox policy when this is defined. The session workspace
   * and mount table still override both: escalation can widen the session
   * policy, but never turns a read-only mount writable.
   */
  get sandboxMode() {
    return 'workspace-write'
  }

  /**
   * Resolve a path, then require the canonical target to be readable.
   *
   * A model-facing call carries the session cwd and gets a sandbox denial
   * outside it. A context-free call comes from harness discovery walking
   * absolute paths (project markers, user instruction files); an unreadable
   * path is reported as `FS_NOT_FOUND`, so walking above a configured
   * workspace parent ends the search instead of failing the turn.
   */
  async resolve(path, opts) {
    const target = await super.resolve(path, opts)
    const sessionRoot = sessionRootFromOptions(opts)
    if (
      !this.mountPolicy.isReadable(String(target.targetKey), {
        sessionRoot,
        allowParents: sessionRoot === undefined,
      })
    ) {
      if (sessionRoot === undefined) {
        throw new FsError(`cannot access "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      throw this.denial('access', target.displayPath)
    }
    return target
  }

  /** Fence lstat by the canonical parent, since the final component is not followed. */
  async lstat(path, opts, signal) {
    if (typeof path === 'string' && path.trim().length > 0) {
      const sessionRoot = sessionRootFromOptions(opts)
      const cwd = sessionRoot ?? this.config.cwd
      const candidate = this.mountPolicy.visiblePathForHostPath(path, cwd, {
        sessionRoot,
        allowParents: sessionRoot === undefined,
      })
      if (candidate === undefined) {
        if (sessionRoot === undefined) return undefined
        throw this.denial('access', path)
      }
    }
    return super.lstat(path, opts, signal)
  }

  /** Keep child targets under a readable directory; drop symlinks that escape. */
  async listDir(target, signal) {
    this.assertVisible(target, 'access', { allowParents: true })
    const entries = await super.listDir(target, signal)
    const parent = String(target.targetKey)
    return entries.filter((entry) => {
      const child = String(entry.target.targetKey)
      if (pathContains(parent, child)) return true
      return this.mountPolicy.isReadable(child, { allowParents: true })
    })
  }

  /** Map a host path only when this backend is allowed to read it. */
  processPathFromHostPath(hostPath) {
    if (typeof hostPath !== 'string' || !isAbsolute(hostPath)) return undefined
    const canonical = realpathOrNormalized(hostPath)
    if (!this.mountPolicy.isReadable(canonical, { allowParents: true })) return undefined
    return super.processPathFromHostPath(canonical)
  }

  /** Fence and re-canonicalize the target immediately before an atomic write. */
  async writeText(target, content, expected, signal, sandboxPolicy) {
    const fresh = await this.writableTarget(target, 'write', sandboxPolicy)
    return super.writeText(fresh, content, expected, signal)
  }

  /** Fence and re-canonicalize the target immediately before an atomic edit. */
  async editText(target, edit, expected, signal, sandboxPolicy) {
    const fresh = await this.writableTarget(target, 'edit', sandboxPolicy)
    return super.editText(fresh, edit, expected, signal)
  }

  /** Reject a target outside the allowed read set. */
  assertVisible(target, verb, options = {}) {
    if (!this.mountPolicy.isReadable(String(target.targetKey), options)) {
      throw this.denial(verb, target.displayPath)
    }
  }

  /**
   * Return the exact target a mutation may use. The target is re-resolved so
   * the checked identity is the one the write/edit receives, and the mount
   * mode is re-checked after canonicalization. The session's `read-only`
   * policy still denies every mutation, while `workspace-write` and
   * `danger-full-access` can only write inside the session workspace or an
   * operator-configured writable mount.
   */
  async writableTarget(target, verb, sandboxPolicy) {
    const mode = sandboxPolicy?.mode
    if (mode === 'read-only') {
      throw new FsError(
        `cannot ${verb} "${target.displayPath}": file access denied under read-only mode`,
        'FS_SANDBOX_DENIED',
      )
    }
    const sessionRoot = sessionRootFromSandboxPolicy(sandboxPolicy)
    const options = { sessionRoot, mode }
    if (!this.mountPolicy.isWritable(String(target.targetKey), options)) {
      throw this.denial(verb, target.displayPath, 'writable roots')
    }
    const fresh = await this.resolve(target.displayPath, sessionRoot === undefined ? undefined : { cwd: sessionRoot })
    if (!this.mountPolicy.isWritable(String(fresh.targetKey), options)) {
      throw this.denial(verb, target.displayPath, 'writable roots')
    }
    return fresh
  }

  /** Structured refusal the dsh tool layer renders as a sandbox denial. */
  denial(verb, displayPath, what = 'sandbox mount roots') {
    return new FsError(
      `cannot ${verb} "${displayPath}": path is outside the ${what}`,
      'FS_SANDBOX_DENIED',
    )
  }
}

/** The session cwd from `resolve`/`lstat` options, when one is supplied. */
function sessionRootFromOptions(opts) {
  const cwd = opts?.cwd
  return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
}

/** The session workspace root from a per-call sandbox policy. */
function sessionRootFromSandboxPolicy(sandboxPolicy) {
  const root = sandboxPolicy?.workspaceRoot
  return typeof root === 'string' && root.trim().length > 0 ? root : undefined
}

export default OpenSandboxFileSystem
