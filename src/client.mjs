import { readFileSync } from 'node:fs'
import { expandHome, errorMessage, sleep, textOr } from './util.mjs'

/** OpenSandbox HTTP/proxy/SSE client used by the world provider. */
export class OpenSandboxError extends Error {
  constructor(message, { code, status } = {}) {
    super(message)
    this.name = 'OpenSandboxError'
    this.code = code
    this.status = status
  }
}

/** Resolve the API key from config, the environment, or a key file. */
export function resolveApiKey({ apiKey, apiKeyFile } = {}) {
  const direct = textOr(apiKey, '')
  if (direct.length > 0) return direct
  const fromEnv = textOr(process.env.OPEN_SANDBOX_API_KEY, '')
  if (fromEnv.length > 0) return fromEnv
  return readApiKeyFile(apiKeyFile)
}

/** Read one API-key file, returning an empty string when it is not available. */
export function readApiKeyFile(apiKeyFile) {
  const file = textOr(apiKeyFile, textOr(process.env.OPEN_SANDBOX_API_KEY_FILE, ''))
  if (file.length === 0) return ''
  try {
    return readFileSync(expandHome(file), 'utf8').trim()
  } catch {
    return ''
  }
}

/** Resolve the full API base (`scheme://host[:port]/v1`). */
export function resolveBaseUrl({ domain, protocol } = {}) {
  const configured = textOr(domain, textOr(process.env.OPEN_SANDBOX_DOMAIN, 'localhost:8080'))
  const scheme = textOr(protocol, textOr(process.env.OPEN_SANDBOX_PROTOCOL, 'http')).replace(/:$/, '')
  if (configured.startsWith('http://') || configured.startsWith('https://')) {
    return `${configured.replace(/\/+$/, '')}/v1`
  }
  return `${scheme}://${configured.replace(/\/+$/, '')}/v1`
}

/** One parsed Server-Sent Event. */
function parseSseChunk(raw) {
  let data = ''
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      const value = line.slice(5)
      data += (data.length > 0 ? '\n' : '') + (value.startsWith(' ') ? value.slice(1) : value)
    }
  }
  if (data.trim().length === 0) {
    // execd also emits legacy bare-JSON frames: one JSON object per
    // blank-line-delimited block, with no `data:` prefix.
    data = raw.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
  }
  if (data.trim().length === 0) return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

/** Yield parsed JSON events from an SSE response body. */
export async function* sseEvents(response, signal) {
  if (response.body === null) throw new OpenSandboxError('OpenSandbox: SSE response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
      }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer)
        if (boundary === null) break
        const raw = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const event = parseSseChunk(raw)
        if (event !== null) {
          yield event
          // execd keeps the SSE connection open after the terminal event, so
          // stop reading and let the finally block cancel the response body.
          if (event.type === 'execution_complete' || event.type === 'error') return
        }
      }
    }
    buffer += decoder.decode()
    const tail = parseSseChunk(buffer)
    if (tail !== null) {
      yield tail
      if (tail.type === 'execution_complete' || tail.type === 'error') return
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

/** HTTP client for one OpenSandbox lifecycle server. */
export class OpenSandboxClient {
  constructor(config = {}) {
    this.baseUrl = resolveBaseUrl(config)
    this.apiKey = resolveApiKey(config)
    this.apiKeyFile = textOr(config.apiKeyFile, textOr(process.env.OPEN_SANDBOX_API_KEY_FILE, ''))
    this.protocol = this.baseUrl.startsWith('https') ? 'https' : 'http'
    this.requestTimeoutMs = Number(config.requestTimeoutMs) > 0 ? Number(config.requestTimeoutMs) : 300_000
    this.execdBases = new Map()
    this.sandboxWaitMs = Number(config.sandboxWaitMs) > 0 ? Number(config.sandboxWaitMs) : 180_000
  }

  /** Request headers, including the API key when one is configured. */
  headers(extra = {}) {
    const headers = { ...extra }
    const key = this.apiKey.length > 0 ? this.apiKey : readApiKeyFile(this.apiKeyFile)
    if (key.length > 0) headers['OPEN-SANDBOX-API-KEY'] = key
    return headers
  }

  /** Make one JSON lifecycle request. */
  async request(method, path, { body, signal, timeoutMs = this.requestTimeoutMs, accept } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const headers = this.headers({ Accept: accept ?? 'application/json' })
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      })
    } catch (error) {
      throw new OpenSandboxError(`OpenSandbox request ${method} ${path} failed: ${errorMessage(error)}`)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let code = `HTTP_${response.status}`
      let message = text
      try {
        const parsed = JSON.parse(text)
        code = parsed.code ?? code
        message = parsed.message ?? text
      } catch {
        // plain-text or empty error body
      }
      throw new OpenSandboxError(`OpenSandbox ${method} ${path} failed: ${message || response.statusText}`, {
        code,
        status: response.status,
      })
    }
    return response
  }

  /** Make one JSON lifecycle request and parse its JSON body. */
  async requestJson(method, path, options) {
    const response = await this.request(method, path, options)
    if (response.status === 204) return null
    return response.json()
  }

  /** Create a sandbox and wait until it reports Running. */
  async createSandbox(body, signal) {
    const created = await this.requestJson('POST', '/sandboxes', { body, signal, timeoutMs: this.requestTimeoutMs })
    const id = textOr(created?.id, '')
    if (id.length === 0) throw new OpenSandboxError('OpenSandbox: create response did not include a sandbox id')
    await this.waitForSandbox(id, signal)
    return id
  }

  /** Poll one sandbox until it is Running. */
  async waitForSandbox(id, signal) {
    const deadline = Date.now() + this.sandboxWaitMs
    for (;;) {
      const info = await this.requestJson('GET', `/sandboxes/${encodeURIComponent(id)}`, { signal })
      const state = String(info?.status?.state ?? info?.state ?? '')
      if (state === 'Running') return
      if (state === 'Failed' || state === 'Terminated' || state === 'Stopping') {
        throw new OpenSandboxError(`OpenSandbox sandbox ${id} entered state ${state}`)
      }
      if (Date.now() >= deadline) {
        throw new OpenSandboxError(`OpenSandbox sandbox ${id} was not Running within ${this.sandboxWaitMs}ms (last state ${state || 'unknown'})`)
      }
      await sleep(500)
    }
  }

  /** Fetch one sandbox, or undefined when it is gone. */
  async getSandbox(id, signal) {
    try {
      return await this.requestJson('GET', `/sandboxes/${encodeURIComponent(id)}`, { signal })
    } catch (error) {
      if (error instanceof OpenSandboxError && error.status === 404) return undefined
      throw error
    }
  }

  /** Kill one sandbox; missing sandboxes are already gone. */
  async killSandbox(id, signal) {
    try {
      await this.request('DELETE', `/sandboxes/${encodeURIComponent(id)}`, { signal })
    } catch (error) {
      if (error instanceof OpenSandboxError && error.status === 404) return
      throw error
    }
  }

  /** Resolve (and cache) the server-proxied execd base for one sandbox. */
  async execdBase(id, signal) {
    const cached = this.execdBases.get(id)
    if (cached !== undefined) return cached
    // Direct published endpoint, the SDK default (use_server_proxy false).
    // The server's own proxy is only needed when the client cannot reach it.
    const endpoint = await this.requestJson(
      'GET',
      `/sandboxes/${encodeURIComponent(id)}/endpoints/44772`,
      { signal },
    )
    let host = textOr(endpoint?.endpoint, '')
    if (host.length === 0) throw new OpenSandboxError(`OpenSandbox: no execd endpoint for sandbox ${id}`)
    if (!host.startsWith('http://') && !host.startsWith('https://')) host = `${this.protocol}://${host}`
    const base = host.replace(/\/+$/, '')
    this.execdBases.set(id, base)
    return base
  }

  /**
   * Start an execd command and return its SSE response.
   *
   * The 60s bound covers only the time until response headers arrive; once the
   * stream is open the caller's signal is the only abort source, because a
   * command is allowed to stream for its whole runtime.
   */
  async command(id, body, signal) {
    const base = await this.execdBase(id, signal)
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason ?? new Error('aborted'))
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    const connectTimer = setTimeout(() => controller.abort(new Error('OpenSandbox command connect timed out')), 60_000)
    let response
    try {
      response = await fetch(`${base}/command`, {
        method: 'POST',
        headers: this.headers({ Accept: 'text/event-stream', 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(connectTimer)
      signal?.removeEventListener('abort', onAbort)
      throw new OpenSandboxError(`OpenSandbox command failed to start: ${errorMessage(error)}`)
    }
    clearTimeout(connectTimer)
    if (!response.ok) {
      signal?.removeEventListener('abort', onAbort)
      const text = await response.text().catch(() => '')
      throw new OpenSandboxError(`OpenSandbox command failed to start (HTTP ${response.status}): ${text}`, {
        status: response.status,
      })
    }
    return response
  }

  /** Interrupt a running command by execd execution id. */
  async interruptCommand(id, executionId, signal) {
    if (executionId.length === 0) return
    const base = await this.execdBase(id, signal)
    try {
      await fetch(`${base}/command?id=${encodeURIComponent(executionId)}`, {
        method: 'DELETE',
        headers: this.headers(),
        signal: signal ?? AbortSignal.timeout(30_000),
      })
    } catch {
      // Best-effort termination; the caller still drops the SSE connection.
    }
  }

  /** Create one PTY session inside a sandbox. */
  async createPty(id, body, signal) {
    const base = await this.execdBase(id, signal)
    const response = await fetch(`${base}/pty`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(60_000),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new OpenSandboxError(`OpenSandbox PTY create failed (HTTP ${response.status}): ${text}`, {
        status: response.status,
      })
    }
    const parsed = await response.json()
    const sessionId = textOr(parsed?.session_id, '')
    if (sessionId.length === 0) throw new OpenSandboxError('OpenSandbox: PTY create response did not include session_id')
    return sessionId
  }

  /** Delete one PTY session; missing sessions are already gone. */
  async deletePty(id, sessionId, signal) {
    const base = await this.execdBase(id, signal)
    try {
      await fetch(`${base}/pty/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: this.headers(),
        signal: signal ?? AbortSignal.timeout(30_000),
      })
    } catch {
      // best-effort cleanup
    }
  }

  /** WebSocket URL for one PTY session. */
  async ptyWsUrl(id, sessionId, signal) {
    const base = await this.execdBase(id, signal)
    return `${base.replace(/^http/, 'ws')}/pty/${encodeURIComponent(sessionId)}/ws`
  }
}
