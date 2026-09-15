import assert from 'node:assert/strict'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { WebSocketServer } from 'ws'
import opensandbox from '../index.mjs'
import { OpenSandboxSubprocess } from '../src/subprocess.mjs'

const captured = { commands: [], pty: [] }
let nextPort = 18080

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`)
  const path = url.pathname
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
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'sbx-test' }))
      return
    }
    if (req.method === 'GET' && path === '/v1/sandboxes/sbx-test') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'sbx-test', status: { state: 'Running' } }))
      return
    }
    if (req.method === 'DELETE' && path === '/v1/sandboxes/sbx-test') {
      res.writeHead(204); res.end(); return
    }
    if (req.method === 'GET' && path === '/v1/sandboxes/sbx-test/endpoints/44772') {
      assert.equal(url.searchParams.get('use_server_proxy'), null)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ endpoint: `127.0.0.1:${server.address().port}/v1/sandboxes/sbx-test/proxy/44772` }))
      return
    }
    if (req.method === 'POST' && path === '/v1/sandboxes/sbx-test/proxy/44772/command') {
      const body = await readJson(req)
      captured.commands.push(body)
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
    if (req.method === 'DELETE' && path === '/v1/sandboxes/sbx-test/proxy/44772/command') {
      captured.commands.push({ interrupted: url.searchParams.get('id') })
      res.writeHead(200); res.end(); return
    }
    if (req.method === 'POST' && path === '/v1/sandboxes/sbx-test/proxy/44772/pty') {
      const body = await readJson(req)
      captured.pty.push(body)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ session_id: 'pty-1' }))
      return
    }
    if (req.method === 'DELETE' && path === '/v1/sandboxes/sbx-test/proxy/44772/pty/pty-1') {
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
  if (url.pathname !== '/v1/sandboxes/sbx-test/proxy/44772/pty/pty-1/ws') {
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

  await provider.close()
  console.log('mock-e2e ok')
} finally {
  wss.close()
  server.close()
}
