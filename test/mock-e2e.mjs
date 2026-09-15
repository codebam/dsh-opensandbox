import assert from 'node:assert/strict'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { WebSocketServer } from 'ws'
import opensandbox from '../index.mjs'
import { OpenSandboxSubprocess } from '../src/subprocess.mjs'

const captured = { commands: [], pty: [], sandboxCreates: [] }
let sandboxSeq = 0
const liveSandboxes = new Set()

function readJson(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { text += chunk })
    req.on('end', () => {
      try {
        const body = text.length > 0 ? JSON.parse(text) : {}
        // Mirror the OpenSandbox label rules so an unsanitized host path in
        // sandbox metadata fails here instead of on a live server.
        if (body !== null && typeof body.metadata === 'object' && body.metadata !== null) {
          for (const [key, value] of Object.entries(body.metadata)) {
            assert.match(
              String(value),
              /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/,
              `metadata ${key}`,
            )
          }
        }
        resolve(body)
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end()
}

// Regression: metadata values must satisfy the OpenSandbox label rules.
const { sanitizeMetadataValue } = await import('../src/subprocess.mjs')
assert.equal(sanitizeMetadataValue('/persistent/etc/nixos'), 'persistent-etc-nixos')
assert.equal(sanitizeMetadataValue('/'), 'workspace')
assert.match(
  sanitizeMetadataValue(`/${'a'.repeat(200)}`),
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/,
)

// Regression: an absent stdout budget must not collapse the stream. The local
// provider this replaces keeps an unbudgeted stream whole ("bytes > undefined"
// is false); keeping one byte truncates every bash-tool result instead.
const { TailCollector } = await import('../src/collect.mjs')
const unbudgeted = new TailCollector({ spillMaxBytes: 1024 })
unbudgeted.push('BASH_TOOL_OK\n')
assert.equal(unbudgeted.readFrom(0).text, 'BASH_TOOL_OK\n')
assert.equal(unbudgeted.readFrom(0).lossy, false)
const budgeted = new TailCollector({ maxBytes: 4 })
budgeted.push('BASH_TOOL_OK\n')
assert.equal(budgeted.readFrom(0).text, '_OK\n')
assert.equal(budgeted.readFrom(0).lossy, true)

// Regression: dsh resolves plugin config through the exported Config schema,
// which materializes an absent optional array as []. That empty array must
// still select the documented /nix/store default, otherwise the container comes
// up with no toolchain mount -- commands still run, so only the missing tools
// and the missing read-only volume reveal it. A plain-object config never
// reaches this path, which is how the bug escaped the earlier mock.
const nixStorePresent = existsSync('/nix/store')
const systemBinPresent = existsSync('/run/current-system/sw/bin')
const loaderResolved = new OpenSandboxSubprocess(
  new Context(),
  opensandbox.Config({
    domain: '127.0.0.1:1',
    apiKey: 'test-key',
    image: 'example/test:latest',
    workspaceRoot: '/tmp',
  }),
)
assert.equal(loaderResolved.config.extraReadOnlyMounts.includes('/nix/store'), nixStorePresent)
if (systemBinPresent) {
  // A dsh started by a systemd user unit inherits systemd's minimal default
  // PATH, which has no /nix/store entries, so the toolchain dirs cannot come
  // from the ambient PATH alone.
  const systemBin = realpathSync('/run/current-system/sw/bin')
  const visible = systemBin === '/nix/store' || systemBin.startsWith('/nix/store/')
  assert.equal(loaderResolved.config.containerPath.includes(systemBin), visible)
  assert.equal(loaderResolved.config.hostSearchDirs.includes(systemBin), visible)
}

// Regression: `forwardEnv` restores host-prepared credentials (GH_TOKEN, the
// SSH agent socket) that the container world would otherwise drop, while an
// explicitly configured `env` entry has to win over a forwarded name.
process.env.OSB_TEST_FORWARDED = 'from-host'
process.env.OSB_TEST_OVERRIDDEN = 'host-value'
const envResolved = new OpenSandboxSubprocess(
  new Context(),
  opensandbox.Config({
    domain: '127.0.0.1:1',
    apiKey: 'test-key',
    image: 'example/test:latest',
    workspaceRoot: '/tmp',
    env: { OSB_TEST_OVERRIDDEN: 'config-value', OSB_TEST_LITERAL: 'literal' },
    forwardEnv: ['OSB_TEST_FORWARDED', 'OSB_TEST_OVERRIDDEN', 'OSB_TEST_UNSET'],
  }),
)
assert.equal(envResolved.config.containerEnv.OSB_TEST_FORWARDED, 'from-host')
assert.equal(envResolved.config.containerEnv.OSB_TEST_OVERRIDDEN, 'config-value')
assert.equal(envResolved.config.containerEnv.OSB_TEST_LITERAL, 'literal')
assert.equal('OSB_TEST_UNSET' in envResolved.config.containerEnv, false)

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`)
  const path = url.pathname
  const sandboxMatch = path.match(/^\/v1\/sandboxes\/([^/]+)$/)
  const endpointMatch = path.match(/^\/v1\/sandboxes\/([^/]+)\/endpoints\/44772$/)
  const commandMatch = path.match(/^\/v1\/sandboxes\/([^/]+)\/proxy\/44772\/command$/)
  const ptyMatch = path.match(/^\/v1\/sandboxes\/([^/]+)\/proxy\/44772\/pty$/)
  const ptyDeleteMatch = path.match(/^\/v1\/sandboxes\/([^/]+)\/proxy\/44772\/pty\/pty-1$/)
  const isLive = (id) => liveSandboxes.has(id)
  try {
    if (req.method === 'POST' && path === '/v1/sandboxes') {
      const body = await readJson(req)
      assert.equal(body.image.uri, 'example/test:latest')
      assert.equal(body.entrypoint[0], '/bin/sh')
      assert.equal(body.volumes[0].mountPath, '/tmp')
      // The default toolchain mount has to survive config resolution.
      if (nixStorePresent) {
        const readOnly = body.volumes.filter((volume) => volume.readOnly === true)
        assert.equal(readOnly.length, 1)
        assert.equal(readOnly[0].mountPath, '/nix/store')
      }
      // Configured and forwarded environment reaches the sandbox itself.
      assert.equal(body.env.OSB_TEST_LITERAL, 'literal')
      assert.equal(body.env.OSB_TEST_FORWARDED, 'from-host')
      sandboxSeq += 1
      const id = sandboxSeq === 1 ? 'sbx-test' : `sbx-test-${sandboxSeq}`
      liveSandboxes.add(id)
      captured.sandboxCreates.push({ id, body })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id }))
      return
    }
    if (req.method === 'GET' && sandboxMatch !== null && isLive(sandboxMatch[1])) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: sandboxMatch[1], status: { state: 'Running' } }))
      return
    }
    if (req.method === 'DELETE' && sandboxMatch !== null) {
      liveSandboxes.delete(sandboxMatch[1])
      res.writeHead(204); res.end(); return
    }
    if (req.method === 'GET' && endpointMatch !== null && isLive(endpointMatch[1])) {
      assert.equal(url.searchParams.get('use_server_proxy'), null)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ endpoint: `127.0.0.1:${server.address().port}/v1/sandboxes/${endpointMatch[1]}/proxy/44772` }))
      return
    }
    if (req.method === 'POST' && commandMatch !== null && isLive(commandMatch[1])) {
      const body = await readJson(req)
      captured.commands.push({ ...body, sandboxId: commandMatch[1] })
      const failed = typeof body.command === 'string' && body.command.includes('__fail')
      if (failed) {
        sse(res, [
          { type: 'init', text: 'cmd-1', timestamp: 1 },
          { type: 'error', error: { ename: 'CommandExecError', evalue: '7', traceback: [] }, timestamp: 2 },
        ])
      } else {
        sse(res, [
          { type: 'init', text: 'cmd-1', timestamp: 1 },
          { type: 'stdout', text: 'hello\n', timestamp: 2 },
          { type: 'stderr', text: 'warn\n', timestamp: 3 },
          { type: 'execution_complete', timestamp: 4 },
        ])
      }
      return
    }
    if (req.method === 'DELETE' && commandMatch !== null) {
      captured.commands.push({ interrupted: url.searchParams.get('id'), sandboxId: commandMatch[1] })
      res.writeHead(200); res.end(); return
    }
    if (req.method === 'POST' && ptyMatch !== null && isLive(ptyMatch[1])) {
      const body = await readJson(req)
      captured.pty.push({ ...body, sandboxId: ptyMatch[1] })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ session_id: 'pty-1' }))
      return
    }
    if (req.method === 'DELETE' && ptyDeleteMatch !== null) {
      res.writeHead(200); res.end(); return
    }
    res.writeHead(404); res.end('not found')
  } catch (error) {
    res.writeHead(500); res.end(String(error))
  }
})

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const match = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)\/proxy\/44772\/pty\/pty-1\/ws$/)
  if (match === null || !liveSandboxes.has(match[1])) {
    socket.destroy(); return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ type: 'connected', mode: 'pty', role: 'holder' }))
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buffer = Buffer.from(data)
        if (buffer[0] === 0x00) {
          const text = buffer.subarray(1).toString('utf8')
          if (text.includes('exit')) {
            ws.send(Buffer.concat([Buffer.from([0x01]), Buffer.from('bye\n')]))
            ws.send(JSON.stringify({ type: 'exit', exit_code: 0 }))
            ws.close()
          }
        }
        return
      }
      const parsed = JSON.parse(String(data))
      if (parsed.type === 'resize') captured.pty.push({ resize: parsed })
      if (parsed.type === 'signal') captured.pty.push({ signal: parsed.signal })
    })
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
try {
  const ctx = new Context()
  const provider = new OpenSandboxSubprocess(ctx, opensandbox.Config({
    domain: `127.0.0.1:${port}`,
    apiKey: 'test-key',
    image: 'example/test:latest',
    workspaceRoot: '/tmp',
    requestTimeoutMs: 10_000,
    sandboxWaitMs: 5_000,
    env: { OSB_TEST_LITERAL: 'literal' },
    forwardEnv: ['OSB_TEST_FORWARDED'],
  }))

  const handle = provider.spawn({
    argv: ['/bin/bash', '-c', 'echo hello'],
    cwd: '/tmp',
    graceMs: 1_000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
  })
  const outcome = await handle.done
  assert.equal(outcome.exitCode, 0)
  assert.equal(handle.collected.stdout.readFrom(0).text, 'hello\n')
  assert.equal(handle.collected.stderr.readFrom(0).text, 'warn\n')
  assert.equal(captured.commands[0].cwd, '/tmp')
  assert.equal(captured.commands[0].command, "'/bin/bash' '-c' 'echo hello'")
  assert.equal(captured.commands[0].argv, undefined)
  assert.equal(captured.commands[0].envs.PATH.includes('/usr/bin'), true)
  assert.equal(captured.commands[0].envs.OSB_TEST_LITERAL, 'literal')
  assert.equal(captured.commands[0].envs.OSB_TEST_FORWARDED, 'from-host')
  if (systemBinPresent) {
    assert.equal(captured.commands[0].envs.PATH.includes(realpathSync('/run/current-system/sw/bin')), true)
  }

  const failed = provider.spawn({
    argv: ['/bin/bash', '-c', '__fail'],
    cwd: '/tmp',
    graceMs: 1_000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
  })
  const failedOutcome = await failed.done
  assert.equal(failedOutcome.exitCode, 7)

  const terminal = await provider.spawnTerminal({
    argv: ['/bin/bash', '--noprofile', '--norc', '-i'],
    cwd: '/tmp',
    env: { PS1: 'dsh> ' },
    rows: 24,
    cols: 80,
    graceMs: 1_000,
  })
  const output = []
  terminal.output.on('data', (chunk) => output.push(String(chunk)))
  await terminal.write('exit\n')
  const termOutcome = await terminal.done
  assert.equal(termOutcome.exitCode, 0)
  assert.equal(output.join('').includes('bye'), true)
  assert.equal(captured.pty[0].cwd, '/tmp')
  assert.equal(captured.pty[0].command.includes("'PS1=dsh> '"), true)
  assert.equal(captured.pty[0].sandboxId, 'sbx-test')

  // Regression: the lifecycle server reaps a sandbox at its TTL. The cached
  // create promise must not keep pointing at the dead execd endpoint; the next
  // command revalidates, creates a replacement, and succeeds instead of
  // failing with `fetch failed` until dsh restarts.
  liveSandboxes.delete('sbx-test')
  const afterExpiry = provider.spawn({
    argv: ['/bin/bash', '-c', 'echo after-expiry'],
    cwd: '/tmp',
    graceMs: 1_000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
  })
  const afterExpiryOutcome = await afterExpiry.done
  assert.equal(afterExpiryOutcome.exitCode, 0)
  assert.equal(afterExpiry.collected.stdout.readFrom(0).text, 'hello\n')
  assert.equal(captured.sandboxCreates.length, 2)
  assert.equal(captured.sandboxCreates[1].id, 'sbx-test-2')
  const lastCommand = captured.commands[captured.commands.length - 1]
  assert.equal(lastCommand.sandboxId, 'sbx-test-2')
  assert.equal(lastCommand.command, "'/bin/bash' '-c' 'echo after-expiry'")

  // A PTY started after the expiry has to ride the replacement sandbox too.
  const terminalAfter = await provider.spawnTerminal({
    argv: ['/bin/bash', '--noprofile', '--norc', '-i'],
    cwd: '/tmp',
    env: { PS1: 'dsh> ' },
    rows: 24,
    cols: 80,
    graceMs: 1_000,
  })
  const outputAfter = []
  terminalAfter.output.on('data', (chunk) => outputAfter.push(String(chunk)))
  await terminalAfter.write('exit\n')
  const termAfterOutcome = await terminalAfter.done
  assert.equal(termAfterOutcome.exitCode, 0)
  assert.equal(outputAfter.join('').includes('bye'), true)
  const lastPtyCreate = [...captured.pty].reverse().find((entry) => entry.sandboxId !== undefined)
  assert.equal(lastPtyCreate.sandboxId, 'sbx-test-2')

  await provider.close()
  console.log('mock-e2e ok')
} finally {
  wss.close()
  server.close()
}
