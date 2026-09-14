import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'

/**
 * Container-world confinement provider.
 *
 * dsh's per-command `ctx.sandbox.confine()` contract wraps an argv under a
 * file-effect policy. In this plugin the execution world itself is an
 * OpenSandbox container: confinement is established when the sandbox is
 * created (its workspace mount and resource boundary), not again for every
 * command inside it. `confine()` therefore passes the argv through untouched
 * and reports `partial` enforcement for confined modes, because the container
 * bounds host file effects but does not re-express read-only/workspace-only
 * semantics inside the container.
 *
 * Keeping this provider mounted lets dsh's stock `dsh-bash-sandbox`,
 * `dsh-terminal-bash`, and permission-escalation flow compose unchanged over
 * the OpenSandbox subprocess provider.
 */
export class OpenSandboxSandboxProvider extends SandboxProvider {
  constructor(ctx, config = {}) {
    super(ctx)
    this.config = config
  }

  /** Return the world's argv unchanged; the container is the boundary. */
  confine(argv, policy) {
    const mode = policy?.mode ?? 'workspace-write'
    return {
      argv: [...argv],
      enforcement: mode === 'danger-full-access' ? 'full' : 'partial',
      denialSignatures: [],
      runnerFailureRules: [],
    }
  }

  /** No provider-owned resources beyond the subprocess world. */
  async close() {}
}
