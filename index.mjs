/**
 * @codebam/dsh-opensandbox
 *
 * A Cordis plugin for the DeepSeek Harness that replaces the host execution
 * world with OpenSandbox containers:
 *
 * - `ctx.subprocess` runs commands and PTY sessions through OpenSandbox execd;
 * - `ctx.sandbox` reports the container world's confinement facts to dsh's
 *   stock sandbox-aware consumers.
 *
 * The stock `dsh-bash-sandbox`, `dsh-terminal-bash`, and `dsh-tool-fs-search`
 * rows then run over the container world without changes. The host filesystem
 * provider stays useful because the configured workspace is bind-mounted at
 * the same absolute path inside the sandbox.
 *
 * @module @codebam/dsh-opensandbox
 */
import z from '@deepseek-ai/schemastery'
import { OpenSandboxSandboxProvider } from './src/sandbox.mjs'
import { OpenSandboxSubprocess } from './src/subprocess.mjs'

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
