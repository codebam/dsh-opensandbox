/**
 * @codebam/dsh-opensandbox
 *
 * A Cordis plugin for the DeepSeek Harness that replaces the host execution
 * world with OpenSandbox containers:
 *
 * - `ctx.subprocess` runs commands and PTY sessions through OpenSandbox execd;
 * - `ctx.sandbox` reports the container world's confinement facts to dsh's
 *   stock sandbox-aware consumers;
 * - `ctx.fs` fences the host filesystem backend to the same mount table, so
 *   the model-facing file tools cannot read or write outside the workspace
 *   and configured mounts.
 *
 * The stock `dsh-bash-sandbox`, `dsh-terminal-bash`, and `dsh-tool-fs-search`
 * rows then run over the container world without changes. The filesystem
 * tools see the same files because the configured workspace is bind-mounted
 * at the same absolute path inside the sandbox.
 *
 * @module @codebam/dsh-opensandbox
 */
import z from '@deepseek-ai/schemastery'
import { registerDirectoryCommands } from './src/commands.mjs'
import { OpenSandboxFileSystem } from './src/fs.mjs'
import { MountPolicy } from './src/mounts.mjs'
import { OpenSandboxSandboxProvider } from './src/sandbox.mjs'
import { OpenSandboxSubprocess } from './src/subprocess.mjs'

export { OpenSandboxFileSystem } from './src/fs.mjs'
export { MountPolicy } from './src/mounts.mjs'
export { OpenSandboxSandboxProvider } from './src/sandbox.mjs'
export { OpenSandboxSubprocess } from './src/subprocess.mjs'
export { OpenSandboxClient, OpenSandboxError } from './src/client.mjs'
export { TailCollector } from './src/collect.mjs'

/** Cordis plugin name. */
export const name = 'dsh-opensandbox'

/** No service must exist before the world provider can be constructed. */
export const inject = []

/** Configuration schema resolved by the dsh loader. */
export const Config = z.object({
  /** OpenSandbox API key; falls back to OPEN_SANDBOX_API_KEY, then apiKeyFile. */
  apiKey: z.string().required(false),
  /** File holding the API key (e.g. $XDG_RUNTIME_DIR/opensandbox/api-key). */
  apiKeyFile: z.string().required(false),
  /** Lifecycle server host[:port], default OPEN_SANDBOX_DOMAIN or localhost:8080. */
  domain: z.string().required(false),
  /** `http` or `https`; default OPEN_SANDBOX_PROTOCOL or `http`. */
  protocol: z.union(['http', 'https']).required(false),
  /** Sandbox image URI. Default: docker.io/library/debian:bookworm-slim. */
  image: z.string().required(false),
  /** Workspace root bind-mounted read-write at the same absolute path. */
  workspaceRoot: z.string().required(false),
  /** Additional host directories mounted read-only at the same absolute path. */
  extraReadOnlyMounts: z.array(z.string()).required(false),
  /**
   * Additional host directories mounted read-write at the same absolute path.
   * This is a host-operator-only grant: keep it out of any model-influenced
   * configuration. Only configured mount roots are bindable; a command cwd
   * outside this table is rejected instead of becoming an arbitrary mount.
   */
  extraWritableMounts: z.array(z.string()).required(false),
  /**
   * Host paths ctx.fs may read for harness-owned features (user skills,
   * `~/.dsh/AGENTS.md`) without exposing them to the container and without
   * making them writable. Keep this list narrow; every entry widens what a
   * model-facing `read` can reach.
   */
  trustedReadPaths: z.array(z.string()).required(false),
  /**
   * Host directories under which dsh web/host sessions may legitimately open
   * a project (for example a code root containing several repositories).
   * They authorise a session workspace, but are not themselves bind-mounted,
   * so a model `workdir` still cannot turn a sibling directory into a mount.
   */
  workspaceParents: z.array(z.string()).required(false),
  /**
   * Host credential/control trees that must stay hidden from ctx.fs unless a
   * trusted read path explicitly covers them or a configured read-only mount
   * exposes them. The OpenSandbox server guard should name the same paths.
   */
  protectedPaths: z.array(z.string()).required(false),
  /**
   * Offer the `/directory-add`, `/directory-remove`, and `/directory-list`
   * human slash commands. The human UI owns consent; an agent cannot invoke
   * the commands. Added mounts are in-memory for this dsh process. Default:
   * true.
   */
  allowDynamicMounts: z.boolean().required(false),
  /**
   * Mount the plugin's mount-fenced ctx.fs backend. Default: true. Disable it
   * only when another provider you trust already supplies `ctx.fs`; with the
   * shipped `dsh-fs-sandbox` still mounted, reads stay unconfined.
   */
  provideFilesystem: z.boolean().required(false),
  /** Sandbox TTL in seconds (minimum 60). Default: 43200 (12h). */
  timeoutSeconds: z.number().required(false),
  /** Lifecycle HTTP request timeout in milliseconds. Default: 300000. */
  requestTimeoutMs: z.number().required(false),
  /** Maximum wait for a new sandbox to report Running, in milliseconds. */
  sandboxWaitMs: z.number().required(false),
  /** Optional per-command execd timeout in milliseconds; 0 disables it. */
  commandTimeoutMs: z.number().required(false),
  /** Container CPU limit string. Default: 4. */
  cpu: z.string().required(false),
  /** Container memory limit string. Default: 8Gi. */
  memory: z.string().required(false),
  /** Container HOME. Default: /root. */
  home: z.string().required(false),
  /** Extra environment variables for every sandbox command; wins over `forwardEnv`. */
  env: z.dict(z.string()).required(false),
  /**
   * Host environment variable names to forward into the sandbox, so tools that
   * authenticate from the host's prepared environment (GH_TOKEN, SSH_AUTH_SOCK)
   * keep working there. Unset or empty names are skipped rather than blanked.
   */
  forwardEnv: z.array(z.string()).required(false),
})

/**
 * Mount the OpenSandbox world and its sandbox-fact provider.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Cordis context.
 * @param {object} config - resolved plugin configuration.
 */
export function apply(ctx, config = {}) {
  const options = config ?? {}
  const subprocess = new OpenSandboxSubprocess(ctx, options)
  const sandbox = new OpenSandboxSandboxProvider(ctx, options)
  if (options.provideFilesystem !== false) {
    if (ctx.get('fs') !== undefined) {
      throw new Error(
        'dsh-opensandbox: ctx.fs is already provided; disable the fs-sandbox row (or set provideFilesystem: false) before mounting this plugin',
      )
    }
    new OpenSandboxFileSystem(ctx, {
      cwd: subprocess.config.workspaceRoot,
      mountPolicy: subprocess.mountPolicy,
    })
  }
  if (subprocess.config.allowDynamicMounts) {
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.effect(
        () => registerDirectoryCommands(commandCtx, subprocess),
        'dsh-opensandbox: directory commands',
      )
    })
  }
  ctx.effect(
    () => () => Promise.allSettled([subprocess.close(), sandbox.close()]),
    'dsh-opensandbox: container world cleanup',
  )
  if (process.env.DSH_OPENSANDBOX_DEBUG === '1') {
    const image = subprocess.config.image
    const root = subprocess.config.workspaceRoot
    console.error(`[dsh-opensandbox] container world mounted: image=${image} workspace=${root}`)
  }
}

export default { name, inject, Config, apply }
