const USAGE_ADD = 'Usage: /directory-add <absolute-host-path> [ro|rw] (default: ro)'
const USAGE_REMOVE = 'Usage: /directory-remove <absolute-host-path>'
const USAGE_LIST = 'Usage: /directory-list (no arguments)'

/**
 * Split a command argument line with POSIX-style single/double quotes so a
 * host path containing spaces can be scoped explicitly.
 */
function tokenize(input) {
  const tokens = []
  let current = ''
  let quote = ''
  let escaped = false
  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
    } else if (char === '\\' && quote !== "'") {
      escaped = true
    } else if (quote.length > 0) {
      if (char === quote) quote = ''
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (escaped) current += '\\'
  if (quote.length > 0) throw new Error('Unmatched quote in command arguments')
  if (current.length > 0) tokens.push(current)
  return tokens
}

/** Parse `/directory-add <path> [ro|rw]`. */
function parseAdd(rawInput) {
  const tokens = tokenize(rawInput)
  if (tokens.length === 0) throw new Error(USAGE_ADD)
  if (tokens.length > 2) throw new Error(USAGE_ADD)
  const access = (tokens[1] ?? 'ro').toLowerCase()
  if (access !== 'ro' && access !== 'rw') throw new Error(USAGE_ADD)
  return { path: tokens[0], access }
}

/** Parse `/directory-remove <path>`. */
function parseRemove(rawInput) {
  const tokens = tokenize(rawInput)
  if (tokens.length !== 1) throw new Error(USAGE_REMOVE)
  return tokens[0]
}

/** Return `{ kind, text }`, the direct-UI command result shape. */
function resultFor(text, kind = 'success') {
  return { kind, text }
}

/** Render the effective mount table for a human. */
function renderMounts(provider) {
  const mounts = provider.listMounts()
  const lines = mounts.map(
    (mount) => `${mount.mode === 'rw' ? 'rw' : 'ro'}  ${mount.path}  [${mount.source}]`,
  )
  return ['Sandbox mount roots:', ...lines].join('\n')
}

/**
 * Register the human-only directory commands.
 *
 * These are slash commands, not model tools: the registry runs them directly
 * against the UI and never turns them into a model message. An agent cannot
 * call them, and the plugin's own mount table remains the only thing
 * `createSandbox` consults.
 *
 * @param commandCtx - context providing the `commands` service.
 * @param provider - the OpenSandbox subprocess world whose mount table moves.
 * @returns a disposer that unregisters all three commands.
 */
export function registerDirectoryCommands(commandCtx, provider) {
  const disposers = []
  disposers.push(
    commandCtx.commands.register({
      name: 'directory-add',
      description: 'Mount an additional host directory into this sandbox session',
      input: { hint: '<absolute-host-path> [ro|rw]' },
      handler: async ({ rawInput }) => {
        try {
          const { path, access } = parseAdd(rawInput)
          const added = await provider.addDynamicMount(path, access)
          const note = access === 'rw' ? ' read-write' : ' read-only'
          if (!added.changed) {
            return resultFor(`Already mounted${note}: ${added.path}`)
          }
          return resultFor(
            `Mounted${note}: ${added.path}\nLive sandboxes were recycled; the next command starts one with the new mount.`,
          )
        } catch (error) {
          return resultFor(error instanceof Error ? error.message : String(error), 'error')
        }
      },
    }),
  )
  disposers.push(
    commandCtx.commands.register({
      name: 'directory-remove',
      description: 'Remove a directory added with /directory-add',
      input: { hint: '<absolute-host-path>' },
      handler: async ({ rawInput }) => {
        try {
          const path = parseRemove(rawInput)
          const removed = await provider.removeDynamicMount(path)
          return resultFor(
            `Removed ${removed.mode} mount: ${removed.path}\nLive sandboxes were recycled; the next command starts one without it.`,
          )
        } catch (error) {
          return resultFor(error instanceof Error ? error.message : String(error), 'error')
        }
      },
    }),
  )
  disposers.push(
    commandCtx.commands.register({
      name: 'directory-list',
      description: 'List the host directories currently visible to this sandbox session',
      handler: ({ rawInput }) => {
        if (rawInput.trim().length > 0) return resultFor(USAGE_LIST, 'error')
        return resultFor(renderMounts(provider))
      },
    }),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
}
