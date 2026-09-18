import { constants as fsConstants, accessSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { PassThrough } from 'node:stream'
import WebSocket from 'ws'
import { SubprocessRuntime, SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { OpenSandboxClient, OpenSandboxError, resolveApiKey, resolveBaseUrl, sseEvents } from './client.mjs'
import { TailCollector } from './collect.mjs'
import { canonicalMountPath, MountPolicy } from './mounts.mjs'
import {
  errorMessage,
  isDirectory,
  pathContains,
  realpathOrNormalized,
  shellJoin,
  sleep,
  textOr,
} from './util.mjs'

const DEFAULT_IMAGE = 'docker.io/library/debian:bookworm-slim'
const DEFAULT_WORKSPACE_TIMEOUT_SECONDS = 12 * 60 * 60
const DEFAULT_RESOURCE_CPU = '4'
const DEFAULT_RESOURCE_MEMORY = '8Gi'
const DEFAULT_CONTAINER_PATH = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']

/**
 * Host bin directories that belong to the toolchain but are not guaranteed to
 * be on the ambient PATH. A dsh started by a systemd user unit inherits
 * systemd's minimal default PATH, which carries no /nix/store entries at all,
 * so the container would have the mount and still no way to name `git`, `nix`
 * or `rg`. Every entry is resolved and mount-checked before use, so a host
 * without these profiles is unaffected.
 */
function wellKnownBinDirs() {
  const dirs = ['/run/current-system/sw/bin', join(homedir(), '.nix-profile/bin')]
  try {
    dirs.push(`/etc/profiles/per-user/${userInfo().username}/bin`)
  } catch {
    // No user-database entry: the other two still apply.
  }
  return dirs
}

/** Normalize plugin configuration into the shape the provider runs with. */
function normalizeConfig(config = {}) {
  const workspaceRoot = realpathOrNormalized(textOr(config.workspaceRoot, process.cwd()))
  // Schemastery materializes an absent optional array as [], so emptiness --
  // not just undefined -- has to select the documented default. Reached
  // through dsh's loader, a bare `[]` here dropped the toolchain mount and left
  // the container with no /nix/store and none of the host tools.
  const requestedReadOnly =
    Array.isArray(config.extraReadOnlyMounts) && config.extraReadOnlyMounts.length > 0
      ? config.extraReadOnlyMounts
      : ['/nix/store']
  const extraReadOnlyMounts = []
  for (const entry of requestedReadOnly) {
    const path = canonicalMountPath(entry)
    if (!isDirectory(path) || extraReadOnlyMounts.includes(path)) continue
    extraReadOnlyMounts.push(path)
  }
  const extraWritableMounts = []
  for (const entry of Array.isArray(config.extraWritableMounts) ? config.extraWritableMounts : []) {
    const path = canonicalMountPath(entry)
    if (!isDirectory(path) || extraWritableMounts.includes(path)) continue
    extraWritableMounts.push(path)
  }
  // Harness-owned host reads (user skills, ~/.dsh/AGENTS.md) that must stay
  // readable through ctx.fs without exposing them to the container and without
  // making them writable. Non-existent paths are allowed: the feature probes
  // them before they exist.
  const trustedReadPaths = []
  for (const entry of Array.isArray(config.trustedReadPaths) ? config.trustedReadPaths : []) {
    const path = canonicalMountPath(entry)
    if (!trustedReadPaths.includes(path)) trustedReadPaths.push(path)
  }
  const requestTimeoutMs = Number(config.requestTimeoutMs) > 0 ? Number(config.requestTimeoutMs) : 300_000
  const sandboxWaitMs = Number(config.sandboxWaitMs) > 0 ? Number(config.sandboxWaitMs) : 180_000
  const timeoutSeconds = Number(config.timeoutSeconds) > 0 ? Number(config.timeoutSeconds) : DEFAULT_WORKSPACE_TIMEOUT_SECONDS
  const commandTimeoutMs = Number(config.commandTimeoutMs) > 0 ? Number(config.commandTimeoutMs) : 0
  const hostSearchDirs = []
  const containerPath = []
  const visibleRoots = [workspaceRoot, ...extraReadOnlyMounts, ...extraWritableMounts]
  // Only directories an actual mount makes visible inside the container count:
  // any other host directory would be a dangling PATH entry there.
  const addSearchDir = (entry) => {
    const real = realpathOrNormalized(entry)
    if (!isDirectory(real)) return
    if (!visibleRoots.some((root) => pathContains(root, real))) return
    if (!hostSearchDirs.includes(real)) hostSearchDirs.push(real)
    if (!containerPath.includes(real)) containerPath.push(real)
  }
  for (const entry of String(process.env.PATH ?? '').split(delimiter)) {
    if (entry.trim().length === 0) continue
    addSearchDir(entry)
  }
  // The ambient PATH wins on order; these only fill in what it did not carry.
  for (const entry of wellKnownBinDirs()) addSearchDir(entry)
  for (const entry of DEFAULT_CONTAINER_PATH) {
    if (!containerPath.includes(entry)) containerPath.push(entry)
  }
  // Environment handed to every sandbox command. Forwarded host names come
  // first and explicit `env` entries win; a forwarded name that is unset on the
  // host is skipped rather than exported empty, so a missing GH_TOKEN looks
  // missing inside the sandbox too.
  const containerEnvOverrides = {}
  for (const name of config.forwardEnv ?? []) {
    const key = String(name)
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0) containerEnvOverrides[key] = value
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (typeof value === 'string') containerEnvOverrides[key] = value
  }
  return {
    workspaceRoot,
    image: textOr(config.image, DEFAULT_IMAGE),
    extraReadOnlyMounts,
    extraWritableMounts,
    trustedReadPaths,
    allowDynamicMounts: config.allowDynamicMounts !== false,
    timeoutSeconds,
    commandTimeoutMs,
    requestTimeoutMs,
    sandboxWaitMs,
    cpu: textOr(config.cpu, DEFAULT_RESOURCE_CPU),
    memory: textOr(config.memory, DEFAULT_RESOURCE_MEMORY),
    containerPath: containerPath.join(delimiter),
    hostSearchDirs,
    containerEnv: {
      PATH: containerPath.join(delimiter),
      HOME: textOr(config.home, '/root'),
      TERM: 'dumb',
      LANG: 'C.UTF-8',
      ...containerEnvOverrides,
    },
    apiKey: resolveApiKey(config),
    apiKeyFile: textOr(config.apiKeyFile, textOr(process.env.OPEN_SANDBOX_API_KEY_FILE, '')),
    baseUrl: resolveBaseUrl(config),
    protocol: textOr(config.protocol, textOr(process.env.OPEN_SANDBOX_PROTOCOL, 'http')),
    domain: textOr(config.domain, textOr(process.env.OPEN_SANDBOX_DOMAIN, 'localhost:8080')),
  }
}

/** A `SubprocessRuntime` whose execution world is OpenSandbox containers. */
export class OpenSandboxSubprocess extends SubprocessRuntime {
  constructor(ctx, config = {}) {
    super(ctx)
    this.config = normalizeConfig(config)
    this.client = new OpenSandboxClient({
      apiKey: this.config.apiKey,
      apiKeyFile: this.config.apiKeyFile,
      domain: this.config.domain,
      protocol: this.config.protocol,
      requestTimeoutMs: this.config.requestTimeoutMs,
      sandboxWaitMs: this.config.sandboxWaitMs,
    })
    this.mountPolicy = new MountPolicy({
      workspaceRoot: this.config.workspaceRoot,
      readOnlyMounts: this.config.extraReadOnlyMounts,
      writableMounts: this.config.extraWritableMounts,
      trustedReadPaths: this.config.trustedReadPaths,
      allowDynamic: this.config.allowDynamicMounts,
    })
    this.sandboxes = new Map()
    this.recycling = Promise.resolve()
    this.executableCache = new Map()
    this.liveProcesses = new Set()
    this.liveTerminals = new Set()
    this.closed = false
  }

  /** Execute one argv in the sandbox and collect its output. Internal helper. */
  async runCollect(argv, { cwd = this.config.workspaceRoot, env = {}, signal, timeoutMs = 0 } = {}) {
    const sandboxId = await this.ensureSandboxFor(cwd)
    const body = {
      command: shellJoin(argv),
      cwd,
      envs: { ...this.config.containerEnv, ...env },
    }
    if (timeoutMs > 0) body.timeout = Math.floor(timeoutMs)
    const response = await this.client.command(sandboxId, body, signal)
    let stdout = ''
    let stderr = ''
    let exitCode = 0
    for await (const event of sseEvents(response, signal)) {
      if (typeof event !== 'object' || event === null) continue
      if (event.type === 'stdout') stdout += typeof event.text === 'string' ? event.text : ''
      else if (event.type === 'stderr') stderr += typeof event.text === 'string' ? event.text : ''
      else if (event.type === 'error') {
        const code = Number.parseInt(String(event.error?.evalue ?? event.error?.value ?? '1'), 10)
        exitCode = Number.isFinite(code) ? code : 1
        stderr += typeof event.error?.value === 'string' && Number.isNaN(code) ? `${event.error.value}\n` : ''
      }
    }
    return { exitCode, stdout, stderr }
  }

  /** Resolve the configured mount root that covers one command cwd. */
  mountRootFor(cwd) {
    const root = this.mountPolicy.rootFor(cwd)
    if (root !== undefined) return root.path
    const roots = this.mountPolicy.describeMounts().map((mount) => mount.path).join(', ')
    throw new OpenSandboxError(
      `OpenSandbox: command cwd ${cwd} is outside every mount root (${roots}); ` +
        'run /directory-add <host-path> [ro|rw] to scope another host directory into this session',
    )
  }

  /** Create, cache, and return one sandbox promise for a workspace root. */
  startSandbox(root) {
    const created = this.createSandbox(root)
    this.sandboxes.set(root, created)
    created.catch(() => {
      if (this.sandboxes.get(root) === created) this.sandboxes.delete(root)
    })
    return created
  }

  /** True when the lifecycle server still reports one sandbox Running. */
  async sandboxIsAlive(sandboxId) {
    const info = await this.client.getSandbox(sandboxId)
    if (info === undefined) return false
    const state = String(info?.status?.state ?? info?.state ?? '')
    return state === 'Running'
  }

  /**
   * Ensure the sandbox for one workspace root exists and is Running.
   *
   * The server reaps a sandbox at its TTL, and a resolved create promise
   * cannot be reused after that: its cached execd endpoint is dead, so every
   * later command fails with `fetch failed` until dsh restarts. Revalidate the
   * cached sandbox against the lifecycle server and create a replacement when
   * it is gone; concurrent callers share the replacement promise.
   */
  async ensureSandboxFor(cwd) {
    if (this.closed) throw new OpenSandboxError('OpenSandbox: provider is closed')
    const root = this.mountRootFor(cwd)
    const cached = this.sandboxes.get(root)
    if (cached === undefined) return this.startSandbox(root)

    let sandboxId = ''
    try {
      sandboxId = await cached
    } catch {
      // A failed create has no id to revalidate; startSandbox below retries.
    }
    if (sandboxId.length > 0) {
      if (await this.sandboxIsAlive(sandboxId)) return sandboxId
      this.client.forgetEndpoint(sandboxId)
    }
    if (this.sandboxes.get(root) === cached) {
      this.sandboxes.delete(root)
      return this.startSandbox(root)
    }
    const replacement = this.sandboxes.get(root)
    return replacement === undefined ? this.startSandbox(root) : replacement
  }

  /** Create one sandbox with the configured host mounts and their modes. */
  async createSandbox(root) {
    const volumes = this.mountPolicy.volumesFor(root)
    const body = {
      image: { uri: this.config.image },
      entrypoint: ['/bin/sh', '-c', 'exec sleep infinity'],
      resourceLimits: { cpu: this.config.cpu, memory: this.config.memory },
      timeout: this.config.timeoutSeconds,
      env: this.config.containerEnv,
      metadata: {
        name: `dsh-opensandbox-${process.pid}`,
        'codebam.dsh.workspace': sanitizeMetadataValue(root),
      },
      volumes,
    }
    return this.client.createSandbox(body)
  }

  /**
   * Add one human-scoped host directory to the mount table and recycle the
   * live sandboxes so the next command starts from the new boundary.
   *
   * This is called only by the `/directory-add` slash command: the human UI
   * owns the consent. The mount is in-memory for this dsh process; profile
   * mounts stay in configuration, which means a restart always returns to the
   * reviewed boundary.
   */
  async addDynamicMount(rawPath, access) {
    const result = this.mountPolicy.addDynamic(rawPath, access)
    if (result.changed) await this.invalidateSandboxes()
    return result
  }

  /** Remove one dynamic mount and recycle the live sandboxes. */
  async removeDynamicMount(rawPath) {
    const result = this.mountPolicy.removeDynamic(rawPath)
    await this.invalidateSandboxes()
    return result
  }

  /** Kill every cached sandbox without closing the provider. */
  invalidateSandboxes() {
    this.recycling = this.recycling.then(() => this.recycleSandboxes()).catch(() => {})
    return this.recycling
  }

  /** Drop and best-effort kill the current sandbox cache. */
  async recycleSandboxes() {
    const pending = [...this.sandboxes.values()]
    this.sandboxes.clear()
    await Promise.allSettled(
      pending.map(async (created) => {
        let sandboxId = ''
        try {
          sandboxId = await created
        } catch {
          return
        }
        if (sandboxId.length === 0) return
        this.client.forgetEndpoint(sandboxId)
        await this.client.killSandbox(sandboxId).catch(() => {})
      }),
    )
  }

  /** The current mount table for `/directory-list`. */
  listMounts() {
    return this.mountPolicy.describe()
  }

  /**
   * Shell-selection facts for the container world. The Debian image is POSIX
   * and carries /bin/bash; the seam expects resolveExecutable to verify the
   * path before allocation.
   */
  async terminalEnvironment(signal) {
    signal?.throwIfAborted()
    return { platform: 'posix', defaultShell: '/bin/bash' }
  }

  /** Resolve one executable in the remote world. */
  async resolveExecutable(command, env, signal) {
    const name = textOr(command, '')
    if (name.length === 0) throw new OpenSandboxError('OpenSandbox: empty executable name')
    if (name.includes('/') || name.includes('\\')) {
      if (!isAbsolute(name)) throw new OpenSandboxError(`OpenSandbox: relative executable paths are not resolved: ${name}`)
      return name
    }
    if (this.executableCache.has(name)) {
      const cached = this.executableCache.get(name)
      if (cached !== undefined) return cached
    }
    for (const dir of this.config.hostSearchDirs) {
      const candidate = join(dir, name)
      try {
        accessSync(candidate, fsConstants.X_OK)
        this.executableCache.set(name, candidate)
        return candidate
      } catch {
        // keep searching
      }
    }
    const result = await this.runCollect(['/bin/sh', '-c', 'command -v -- "$1"', 'sh', name], {
      signal,
      env: env ?? {},
    })
    const resolved = result.stdout.trim().split('\n')[0] ?? ''
    if (result.exitCode !== 0 || resolved.length === 0) {
      throw new SubprocessExecutableNotFoundError(`OpenSandbox: executable ${JSON.stringify(name)} was not found in the sandbox`)
    }
    this.executableCache.set(name, resolved)
    return resolved
  }

  /**
   * Start one managed process. Foreground and background consumers share this
   * path; job semantics belong to the caller.
   */
  spawn(spec) {
    if (this.closed) throw new OpenSandboxError('OpenSandbox: provider is closed')
    if (!Array.isArray(spec.argv) || spec.argv.length === 0) throw new OpenSandboxError('OpenSandbox: spawn requires a non-empty argv')
    if (typeof spec.cwd !== 'string' || spec.cwd.length === 0) throw new OpenSandboxError('OpenSandbox: spawn requires a cwd')
    if (spec.stdio?.stdin === 'pipe') {
      throw new OpenSandboxError('OpenSandbox: interactive stdin pipes are not supported; pass { data } or ignore stdin')
    }
    if (spec.stdio?.control === 'pipe') {
      throw new OpenSandboxError('OpenSandbox: the control duplex pipe is not supported over execd')
    }
    const processHandle = new OpenSandboxCommandProcess(this, spec)
    this.liveProcesses.add(processHandle)
    processHandle.done.finally(() => this.liveProcesses.delete(processHandle)).catch(() => {})
    return processHandle
  }

  /** Start one PTY shell session inside the sandbox. */
  async spawnTerminal(spec) {
    if (this.closed) throw new OpenSandboxError('OpenSandbox: provider is closed')
    const terminal = new OpenSandboxTerminalHandle(this, spec)
    this.liveTerminals.add(terminal)
    terminal.done.finally(() => this.liveTerminals.delete(terminal)).catch(() => {})
    await terminal.start()
    return terminal
  }

  /** Terminate the world: running commands, PTY sessions, and sandboxes. */
  async close() {
    if (this.closed) return
    this.closed = true
    await this.recycling.catch(() => {})
    for (const processHandle of [...this.liveProcesses]) processHandle.terminate()
    for (const terminal of [...this.liveTerminals]) await terminal.terminate().catch(() => {})
    const sandboxes = await Promise.allSettled([...this.sandboxes.values()])
    for (const result of sandboxes) {
      if (result.status !== 'fulfilled') continue
      await this.client.killSandbox(result.value).catch(() => {})
    }
    this.sandboxes.clear()
  }
}

// OpenSandbox metadata values are label-like (<=63 chars, alphanumeric plus
// '-', '_' and '.', starting and ending alphanumeric), so a host path cannot
// be stored verbatim: every absolute path starts with '/'.
export function sanitizeMetadataValue(value) {
  const slug = String(value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 63)
    .replace(/[^A-Za-z0-9]+$/, '')
  return slug.length > 0 ? slug : 'workspace'
}

/** One managed command backed by an execd `/command` SSE stream. */
class OpenSandboxCommandProcess {
  constructor(provider, spec) {
    this.provider = provider
    this.spec = spec
    this.client = provider.client
    this.controller = new AbortController()
    this.sandboxId = ''
    this.executionId = ''
    this.terminated = false
    this.settled = false
    this.exitCode = null
    this.signal = null
    this.collectorOut = null
    this.collectorErr = null
    this.pipeOut = null
    this.pipeErr = null
    this.stdout = undefined
    this.stderr = undefined
    this.stdin = undefined
    this.handleAbort = () => this.terminate()
    this.spec.signal?.addEventListener('abort', this.handleAbort, { once: true })

    const stdoutMode = spec.stdio?.stdout
    const stderrMode = spec.stdio?.stderr
    if (isCollectMode(stdoutMode)) {
      this.collectorOut = new TailCollector({ maxBytes: stdoutMode.maxBytes, spillMaxBytes: stdoutMode.spill?.maxBytes })
    } else if (stdoutMode === 'pipe') {
      this.pipeOut = new PassThrough()
      this.stdout = this.pipeOut
    } else if (stdoutMode === 'inherit') {
      this.pipeOut = process.stdout
    }
    if (isCollectMode(stderrMode)) {
      this.collectorErr = new TailCollector({ maxBytes: stderrMode.maxBytes, spillMaxBytes: stderrMode.spill?.maxBytes })
    } else if (stderrMode === 'pipe') {
      this.pipeErr = new PassThrough()
      this.stderr = this.pipeErr
    } else if (stderrMode === 'inherit') {
      this.pipeErr = process.stderr
    }

    const collected = {}
    if (this.collectorOut !== null) collected.stdout = this.collectorOut
    if (this.collectorErr !== null) collected.stderr = this.collectorErr
    this.collected = collected

    let resolveDone
    let rejectDone
    this.done = new Promise((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    this.resolveDone = (outcome) => {
      if (this.settled) return
      this.settled = true
      this.spec.signal?.removeEventListener('abort', this.handleAbort)
      this.finishStreams()
      resolveDone(outcome)
    }
    this.rejectDone = (error) => {
      if (this.settled) return
      this.settled = true
      this.spec.signal?.removeEventListener('abort', this.handleAbort)
      this.finishStreams()
      rejectDone(error)
    }
    this.start()
  }

  /** Resolve the sandbox, run the command, and consume its event stream. */
  async start() {
    try {
      const root = this.provider.mountRootFor(this.spec.cwd)
      this.sandboxId = await this.provider.ensureSandboxFor(root)
      const env = { ...this.provider.config.containerEnv, ...(this.spec.env ?? {}) }
      const command = shellJoin(this.spec.argv)
      const body = {
        command,
        cwd: this.spec.cwd,
        envs: env,
      }
      if (this.provider.config.commandTimeoutMs > 0) body.timeout = this.provider.config.commandTimeoutMs
      const stdin = this.spec.stdio?.stdin
      if (stdin !== undefined && stdin !== 'ignore' && typeof stdin === 'object') {
        const encoded = Buffer.from(String(stdin.data ?? ''), 'utf8').toString('base64')
        body.command = `printf '%s' '${encoded}' | base64 -d | ${command}`
      }
      const response = await this.client.command(this.sandboxId, body, this.controller.signal)
      for await (const event of sseEvents(response, this.controller.signal)) {
        if (typeof event !== 'object' || event === null) continue
        switch (event.type) {
          case 'init': {
            this.executionId = textOr(event.text, '')
            if (this.terminated) await this.interrupt()
            break
          }
          case 'stdout': {
            const text = typeof event.text === 'string' ? event.text : ''
            if (this.collectorOut !== null) this.collectorOut.push(text)
            if (this.pipeOut !== null && this.pipeOut !== process.stdout) this.pipeOut.write(text)
            else if (this.pipeOut === process.stdout) process.stdout.write(text)
            break
          }
          case 'stderr': {
            const text = typeof event.text === 'string' ? event.text : ''
            if (this.collectorErr !== null) this.collectorErr.push(text)
            if (this.pipeErr !== null && this.pipeErr !== process.stderr) this.pipeErr.write(text)
            else if (this.pipeErr === process.stderr) process.stderr.write(text)
            break
          }
          case 'error': {
            const raw = String(event.error?.evalue ?? event.error?.value ?? '1')
            const parsed = Number.parseInt(raw, 10)
            this.exitCode = Number.isFinite(parsed) ? parsed : 1
            break
          }
          case 'execution_complete': {
            if (this.exitCode === null) this.exitCode = 0
            break
          }
          default:
            break
        }
      }
      if (this.terminated) {
        this.exitCode = this.exitCode ?? null
        this.signal = 'SIGKILL'
      }
      this.resolveDone({ exitCode: this.exitCode ?? 0, signal: this.signal })
    } catch (error) {
      if (this.terminated || this.controller.signal.aborted || this.spec.signal?.aborted === true) {
        this.resolveDone({ exitCode: this.exitCode ?? null, signal: 'SIGKILL' })
        return
      }
      this.rejectDone(error instanceof Error ? error : new OpenSandboxError(errorMessage(error)))
    }
  }

  /** Best-effort interrupt of the remote command. */
  async interrupt() {
    if (this.sandboxId.length === 0 || this.executionId.length === 0) return
    await this.client.interruptCommand(this.sandboxId, this.executionId).catch(() => {})
  }

  /** The seam's only termination verb; idempotent. */
  terminate() {
    if (this.settled) return
    this.terminated = true
    void this.interrupt().finally(() => {
      this.controller.abort(new Error('terminated'))
    })
  }

  /** Wait until the remote command range is empty. */
  waitForExit(signal) {
    if (signal?.aborted === true) return Promise.resolve(false)
    return new Promise((resolveWait) => {
      const onAbort = () => resolveWait(false)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.done.finally(() => {
        signal?.removeEventListener('abort', onAbort)
        resolveWait(true)
      })
    })
  }

  /** End any provider-owned raw streams once the command settles. */
  finishStreams() {
    if (this.pipeOut instanceof PassThrough) this.pipeOut.end()
    if (this.pipeErr instanceof PassThrough) this.pipeErr.end()
    this.collectorOut?.close?.()
    this.collectorErr?.close?.()
  }
}

/** One PTY shell backed by an execd PTY WebSocket. */
class OpenSandboxTerminalHandle {
  constructor(provider, spec) {
    this.provider = provider
    this.spec = spec
    this.client = provider.client
    this.sandboxId = ''
    this.sessionId = ''
    this.ws = null
    this.terminated = false
    this.settled = false
    this.exitCode = null
    this.signal = null
    this.output = new PassThrough()
    this.pid = 0
    let resolveDone
    let rejectDone
    this.done = new Promise((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    this.resolveDone = (outcome) => {
      if (this.settled) return
      this.settled = true
      this.output.end()
      resolveDone(outcome)
    }
    this.rejectDone = (error) => {
      if (this.settled) return
      this.settled = true
      this.output.destroy(error)
      rejectDone(error)
    }
  }

  /** Create the PTY session and attach its WebSocket. */
  async start() {
    try {
      const root = this.provider.mountRootFor(this.spec.cwd)
      this.sandboxId = await this.provider.ensureSandboxFor(root)
      const env = {
        ...this.provider.config.containerEnv,
        ...(this.spec.terminalType === undefined ? {} : { TERM: this.spec.terminalType }),
        ...(this.spec.env ?? {}),
      }
      const argv = Array.isArray(this.spec.argv) && this.spec.argv.length > 0 ? this.spec.argv : ['/bin/bash', '--noprofile', '--norc', '-i']
      const assignments = Object.entries(env).map(([key, value]) => `${key}=${String(value)}`)
      const command = `exec ${shellJoin(['env', ...assignments, ...argv])}`
      this.sessionId = await this.client.createPty(this.sandboxId, { cwd: this.spec.cwd, command })
      const url = await this.client.ptyWsUrl(this.sandboxId, this.sessionId)
      this.ws = new WebSocket(url, { headers: this.client.headers() })
      this.ws.binaryType = 'nodebuffer'
      await new Promise((resolveOpen, rejectOpen) => {
        const onOpen = () => {
          cleanup()
          resolveOpen()
        }
        const onError = (error) => {
          cleanup()
          rejectOpen(error)
        }
        const cleanup = () => {
          this.ws.off('open', onOpen)
          this.ws.off('error', onError)
        }
        this.ws.on('open', onOpen)
        this.ws.on('error', onError)
      })
      this.ws.on('message', (data, isBinary) => this.onMessage(data, isBinary))
      this.ws.on('close', () => this.onClose())
      this.ws.on('error', (error) => this.rejectDone(error instanceof Error ? error : new Error(String(error))))
      this.sendJson({ type: 'resize', cols: this.spec.cols, rows: this.spec.rows })
    } catch (error) {
      await this.deleteRemote().catch(() => {})
      throw error instanceof Error ? error : new OpenSandboxError(errorMessage(error))
    }
  }

  /** Decode holder frames and terminal control frames. */
  onMessage(data, isBinary) {
    if (!isBinary) {
      let parsed
      try {
        parsed = JSON.parse(String(data))
      } catch {
        return
      }
      if (parsed?.type === 'exit') {
        const exitCode = Number.isFinite(parsed.exit_code) ? parsed.exit_code : null
        this.resolveDone({ exitCode, signal: null })
      }
      return
    }
    const buffer = Buffer.from(data)
    if (buffer.length === 0) return
    const payload = buffer.subarray(1)
    if (buffer[0] === 0x01 || buffer[0] === 0x02) this.output.write(payload)
  }

  /** Resolve or reject once the WebSocket closes. */
  onClose() {
    if (this.settled) return
    if (this.terminated) this.resolveDone({ exitCode: null, signal: null })
    else this.rejectDone(new OpenSandboxError('OpenSandbox: PTY WebSocket closed before the shell exited'))
  }

  /** Write stdin (0x00 + raw UTF-8 bytes). */
  async write(data) {
    if (this.terminated) throw new OpenSandboxError('OpenSandbox: PTY is terminating')
    this.sendBinary(Buffer.concat([Buffer.from([0x00]), Buffer.from(String(data), 'utf8')]))
  }

  /** Change the remote PTY dimensions. */
  async resize(cols, rows) {
    if (this.terminated) throw new OpenSandboxError('OpenSandbox: PTY is terminating')
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
      throw new OpenSandboxError('OpenSandbox: terminal dimensions must be positive integers')
    }
    this.sendJson({ type: 'resize', cols, rows })
  }

  /** Remote PTY foreground inspection is not exposed; consumers fall back. */
  async inspectForeground() {
    return undefined
  }

  /** Deliver a signal to the PTY's foreground process group. */
  async signalForeground(signal) {
    this.sendJson({ type: 'signal', signal })
    return 0
  }

  /** Close the WebSocket and delete the remote PTY session. */
  async terminate() {
    if (this.terminated) return
    this.terminated = true
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
    await this.deleteRemote()
    this.resolveDone({ exitCode: null, signal: null })
  }

  /** Delete the remote PTY session when one was created. */
  async deleteRemote() {
    if (this.sandboxId.length > 0 && this.sessionId.length > 0) {
      await this.client.deletePty(this.sandboxId, this.sessionId).catch(() => {})
    }
  }

  /** Send one text control frame when the socket is open. */
  sendJson(value) {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(value))
  }

  /** Send one binary stdin frame when the socket is open. */
  sendBinary(value) {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) this.ws.send(value)
  }
}

/** True when one stdio disposition asks for bounded collected output. */
function isCollectMode(mode) {
  return typeof mode === 'object' && mode !== null && !Array.isArray(mode)
}
