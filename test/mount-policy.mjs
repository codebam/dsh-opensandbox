import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MountPolicy, OpenSandboxFileSystem, OpenSandboxSubprocess } from '../index.mjs'
import { registerDirectoryCommands } from '../src/commands.mjs'

const base = mkdtempSync(join(tmpdir(), 'dsh-opensandbox-mounts-'))
const workspace = join(base, 'workspace')
const readOnly = join(base, 'read-only')
const writable = join(base, 'writable')
const dynamic = join(base, 'dynamic')
const trusted = join(base, 'trusted', 'AGENTS.md')
mkdirSync(workspace)
mkdirSync(readOnly)
mkdirSync(writable)
mkdirSync(dynamic)
mkdirSync(join(base, 'trusted'))
writeFileSync(trusted, 'trusted instructions\n')
writeFileSync(join(workspace, 'workspace.txt'), 'workspace\n')
writeFileSync(join(readOnly, 'read-only.txt'), 'read only\n')

try {
  // ── MountPolicy: configured roots, overlap rejection, dynamic mounts ─────
  const policy = new MountPolicy({
    workspaceRoot: workspace,
    readOnlyMounts: [readOnly],
    writableMounts: [writable],
    trustedReadPaths: [trusted],
  })
  assert.equal(policy.rootFor(join(workspace, 'missing', 'file.txt'))?.path, workspace)
  assert.equal(policy.rootFor(readOnly)?.path, readOnly)
  assert.equal(policy.rootFor(writable)?.path, writable)
  assert.equal(policy.rootFor(join(workspace, '..', 'read-only'))?.path, readOnly)
  assert.equal(policy.isWritable(join(workspace, 'x')), true)
  assert.equal(policy.isWritable(join(readOnly, 'x')), false)
  assert.equal(policy.isVisible(trusted), true)
  assert.equal(policy.isVisible('/etc/passwd'), false)

  assert.throws(
    () => new MountPolicy({ workspaceRoot: workspace, readOnlyMounts: [readOnly], writableMounts: [readOnly] }),
    /configured both read-only and read-write/,
  )
  assert.throws(
    () => new MountPolicy({ workspaceRoot: workspace, writableMounts: [base] }),
    /mount roots overlap/,
  )
  assert.throws(
    () => new MountPolicy({ workspaceRoot: workspace, readOnlyMounts: ['/'] }),
    /mount roots overlap/,
  )

  const added = policy.addDynamic(join(base, 'dynamic'), 'ro')
  assert.deepEqual(added, { path: dynamic, mode: 'ro', changed: true })
  assert.equal(policy.isWritable(dynamic), false)
  assert.deepEqual(policy.addDynamic(dynamic, 'ro'), { path: dynamic, mode: 'ro', changed: false })
  assert.throws(() => policy.addDynamic(dynamic, 'rw'), /already mounted read-only/)
  assert.throws(() => policy.addDynamic(join(readOnly, 'nested'), 'ro'), /already visible/)
  assert.throws(() => policy.addDynamic(join(base, 'missing'), 'ro'), /not an existing host directory/)
  assert.throws(() => policy.addDynamic('relative/path', 'ro'), /must be absolute/)
  assert.throws(() => policy.addDynamic('/', 'ro'), /refusing to mount the host root/)
  const removed = policy.removeDynamic(dynamic)
  assert.deepEqual(removed, { path: dynamic, mode: 'ro' })
  assert.throws(() => policy.removeDynamic(dynamic), /not a mounted directory/)
  assert.throws(() => policy.removeDynamic(readOnly), /comes from the dsh profile configuration/)
  const disabled = new MountPolicy({ workspaceRoot: workspace, allowDynamic: false })
  assert.throws(() => disabled.addDynamic(readOnly, 'ro'), /dynamic directory mounts are disabled/)

  const dynamicRw = join(base, 'dynamic-rw')
  mkdirSync(dynamicRw)
  policy.addDynamic(dynamicRw, 'rw')
  const volumes = policy.volumesFor(workspace)
  const byPath = new Map(volumes.map((volume) => [volume.mountPath, volume]))
  assert.equal(byPath.get(workspace).readOnly, undefined)
  assert.equal(byPath.get(readOnly).readOnly, true)
  assert.equal(byPath.get(writable).readOnly, undefined)
  assert.equal(byPath.get(dynamicRw).readOnly, undefined)

  // ── OpenSandboxFileSystem: reads and writes are mount-fenced ─────────────
  const fsCtx = new Context()
  const fs = new OpenSandboxFileSystem(fsCtx, { mountPolicy: policy, cwd: workspace })
  assert.equal(await fs.readText(await fs.resolve('workspace.txt')), 'workspace\n')
  assert.equal(await fs.readText(await fs.resolve(join(readOnly, 'read-only.txt'))), 'read only\n')
  assert.equal(await fs.readText(await fs.resolve(trusted)), 'trusted instructions\n')
  await assert.rejects(fs.resolve('/etc/passwd'), (error) => error.code === 'FS_SANDBOX_DENIED')
  await assert.rejects(fs.resolve(join(readOnly, 'x.txt')).then((target) => fs.writeText(target, 'x')), (error) => error.code === 'FS_SANDBOX_DENIED')
  const writableTarget = await fs.resolve(join(writable, 'written.txt'))
  await fs.writeText(writableTarget, 'written\n', { kind: 'createIfAbsent' })
  assert.equal(await fs.readText(writableTarget), 'written\n')
  const newTarget = await fs.resolve('created.txt')
  await fs.writeText(newTarget, 'created\n', { kind: 'createIfAbsent' })
  assert.equal(await fs.readText(newTarget), 'created\n')
  assert.equal(fs.processPathFromHostPath('/etc/passwd'), undefined)
  assert.equal(fs.processPathFromHostPath(join(workspace, 'workspace.txt')), join(workspace, 'workspace.txt'))
  assert.equal(fs.sandboxMode, 'workspace-write')

  // ── OpenSandboxSubprocess: arbitrary absolute cwd is rejected ────────────
  const provider = new OpenSandboxSubprocess(new Context(), {
    domain: '127.0.0.1:1',
    apiKey: 'test-key',
    workspaceRoot: workspace,
    extraReadOnlyMounts: [readOnly],
    extraWritableMounts: [writable],
    allowDynamicMounts: true,
  })
  assert.equal(provider.mountRootFor(join(workspace, 'nested', 'missing')), workspace)
  assert.equal(provider.mountRootFor(readOnly), readOnly)
  assert.equal(provider.mountRootFor(writable), writable)
  assert.throws(() => provider.mountRootFor('/etc'), /outside every mount root/)
  const escape = join(workspace, 'escape-link')
  symlinkSync('/etc', escape)
  assert.throws(() => provider.mountRootFor(escape), /outside every mount root/)

  // ── /directory-add, /directory-remove, /directory-list ───────────────────
  const definitions = new Map()
  const commandCtx = {
    commands: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
  }
  const disposeCommands = registerDirectoryCommands(commandCtx, provider)
  const run = async (name, rawInput) => definitions.get(name).handler({ rawInput })
  const addResult = await run('directory-add', `${dynamicRw} rw`)
  assert.equal(addResult.kind, 'success')
  assert.match(addResult.text, /Mounted read-write/)
  assert.equal(provider.listMounts().find((mount) => mount.path === dynamicRw)?.mode, 'rw')
  const listed = await run('directory-list', '')
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /rw\s+.*dynamic-rw/)
  const quoted = join(base, 'quoted directory')
  mkdirSync(quoted)
  const quotedAdd = await run('directory-add', `"${quoted}" ro`)
  assert.equal(quotedAdd.kind, 'success')
  assert.equal(provider.listMounts().find((mount) => mount.path === quoted)?.mode, 'ro')
  const removeResult = await run('directory-remove', `"${quoted}"`)
  assert.equal(removeResult.kind, 'success')
  assert.equal(provider.listMounts().some((mount) => mount.path === quoted), false)
  assert.equal((await run('directory-add', '/etc/passwd')).kind, 'error')
  assert.equal((await run('directory-add', '/')).kind, 'error')
  assert.equal((await run('directory-add', 'relative')).kind, 'error')
  assert.equal((await run('directory-add', `${readOnly} rw`)).kind, 'error')
  assert.equal((await run('directory-remove', '/etc')).kind, 'error')
  assert.equal((await run('directory-list', 'extra')).kind, 'error')
  disposeCommands()

  await provider.close()
  console.log('mount-policy ok')
} finally {
  rmSync(base, { recursive: true, force: true })
}
