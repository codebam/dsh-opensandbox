import { isAbsolute } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { MountPolicy } from './mounts.mjs'
import { realpathOrNormalized } from './util.mjs'

const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

/**
 * A host filesystem backend fenced by the same mount table as the container
 * world.
 *
 * dsh's shipped `@deepseek-ai/dsh-fs-sandbox` confines writes but deliberately
 * leaves reads unconfined, because the host filesystem is normally the
 * execution world. This plugin swaps the execution world for an OpenSandbox
 * container, so the host filesystem is no longer the world the model should
 * read: a `read`/`grep`/`read_image` call must not reach outside the paths the
 * sandbox already exposes. This backend extends the local backend (target
 * identity, atomic writes, edit semantics) and adds a mount-table fence to
 * resolve/lstat and to both mutations. Reads and writes are allowed only under
 * a configured sandbox mount; writes additionally require a writable mount.
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
   * the per-call sandbox policy when this is defined. The mount table still
   * overrides both: escalation can widen the session-defined writable set, but
   * never turns a read-only mount writable.
   */
  get sandboxMode() {
    return 'workspace-write'
  }

  /** Resolve a path, then require the canonical target to be inside a mount. */
  async resolve(path, opts) {
    const target = await super.resolve(path, opts)
    this.assertVisible(target, 'access')
    return target
  }

  /** Fence lstat by the canonical parent, since the final component is not followed. */
  async lstat(path, opts, signal) {
    if (typeof path === 'string' && path.trim().length > 0) {
      const cwd = opts?.cwd ?? this.config.cwd
      if (this.mountPolicy.visiblePathForHostPath(path, cwd) === undefined) {
        throw this.denial('access', path)
      }
    }
    return super.lstat(path, opts, signal)
  }

  /** Drop directory entries whose resolved target escapes the mount table. */
  async listDir(target, signal) {
    this.assertVisible(target, 'access')
    const entries = await super.listDir(target, signal)
    return entries.filter((entry) => this.mountPolicy.isVisible(String(entry.target.targetKey)))
  }

  /** Map a host path only when this backend is allowed to read it. */
  processPathFromHostPath(hostPath) {
    if (typeof hostPath !== 'string' || !isAbsolute(hostPath)) return undefined
    const canonical = realpathOrNormalized(hostPath)
    if (!this.mountPolicy.isVisible(canonical)) return undefined
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

  /** Reject a target outside every sandbox mount. */
  assertVisible(target, verb) {
    if (!this.mountPolicy.isVisible(String(target.targetKey))) {
      throw this.denial(verb, target.displayPath)
    }
  }

  /**
   * Return the exact target a mutation may use. The target is re-resolved so
   * the checked identity is the one the write/edit receives, and the mount
   * mode is re-checked after canonicalization. The session's `read-only` policy
   * still denies every mutation, while `workspace-write` and
   * `danger-full-access` can only write where the operator mounted read-write.
   */
  async writableTarget(target, verb, sandboxPolicy) {
    const mode = sandboxPolicy?.mode
    if (mode === 'read-only') {
      throw new FsError(
        `cannot ${verb} "${target.displayPath}": file access denied under read-only mode`,
        'FS_SANDBOX_DENIED',
      )
    }
    if (!this.mountPolicy.isWritable(String(target.targetKey))) {
      throw new FsError(
        `cannot ${verb} "${target.displayPath}": path is outside the sandbox writable roots`,
        'FS_SANDBOX_DENIED',
      )
    }
    const fresh = await this.resolve(target.displayPath)
    if (!this.mountPolicy.isWritable(String(fresh.targetKey))) {
      throw new FsError(
        `cannot ${verb} "${target.displayPath}": path is outside the sandbox writable roots`,
        'FS_SANDBOX_DENIED',
      )
    }
    return fresh
  }

  /** Structured refusal the dsh tool layer renders as a sandbox denial. */
  denial(verb, displayPath) {
    return new FsError(
      `cannot ${verb} "${displayPath}": path is outside the sandbox mount roots`,
      'FS_SANDBOX_DENIED',
    )
  }
}

export default OpenSandboxFileSystem
