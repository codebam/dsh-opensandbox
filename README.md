# @codebam/dsh-opensandbox

Run the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) execution world inside
[OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) containers.

The plugin registers two dsh services:

| Service | Replacement | Effect |
| --- | --- | --- |
| `ctx.subprocess` | `@deepseek-ai/dsh-subprocess-local` | Commands and PTY shells run through OpenSandbox execd. |
| `ctx.sandbox` | `@deepseek-ai/dsh-sandbox-local` | Reports the container world's confinement facts to dsh's stock sandbox-aware consumers. |

Because `ctx.subprocess` is the shared execution seam, these existing dsh plugins keep working
over the container world without code changes:

- `@deepseek-ai/dsh-bash-sandbox` — the model-facing `bash` tool
- `@deepseek-ai/dsh-terminal-bash` — persistent PTY sessions (`bash`)
- `@deepseek-ai/dsh-tool-fs-search` — `grep`/`glob` run inside the sandbox
- dsh's permission/escalation flow and `sandbox:policy` context

The configured workspace is bind-mounted into the sandbox at the same absolute path, so the host
`ctx.fs` provider and the sandbox see the same files. `ctx.fs` itself stays host-side in this
release: the container is the boundary for **command execution**, not a replacement filesystem.

## Requirements

- Node.js >= 20 (dsh bundles a newer Node).
- A reachable OpenSandbox lifecycle server with the Docker runtime.
- The OpenSandbox server must allow-list the host paths you mount. In its TOML:

  ```toml
  [storage]
  allowed_host_paths = ["/home/your-user", "/persistent", "/tmp", "/nix/store"]
  ```

- The sandbox image must contain `/bin/sh` and a `sleep` that accepts `infinity`
  (`debian:*`, `ubuntu:*`, `python:*` and similar images do).

### Known limitations

- `spawnTerminal` needs a WebSocket to execd, so this plugin asks the lifecycle
  API for each sandbox's **direct** published endpoint (the official SDK default,
  `use_server_proxy=false`) instead of routing through the server's own proxy.
  That is deliberate: in the stock server image the API-proxy WebSocket route
  never completes its handshake to the sandbox and then crashes while reporting
  that failure on a `websockets` API mismatch. A deployment where the client
  cannot reach the sandbox's published port directly is not supported.
- `ctx.fs` stays host-side, and confinement inside the container is the
  container itself: `confine()` reports `partial` enforcement for confined modes
  because read-only/workspace-only semantics are not re-expressed per command.
- Mounted host paths must be allow-listed by the server
  (`[storage] allowed_host_paths`); a session cwd outside that list fails at
  sandbox creation rather than falling back to the host.

## Install

```bash
npm install @codebam/dsh-opensandbox
```

dsh provides the `@deepseek-ai/*` peer packages at runtime, so they are marked optional and are not
fetched from npm by this package.

## Configure dsh

Add the plugin to a dsh profile and disable the two local providers it replaces. A profile
`cordis.patch.yml` (for example `$DSH_HOME/profiles/dsh-tui/cordis.patch.yml`) looks like this:

```yaml
- id: subprocess
  disabled: true

- id: sandbox
  disabled: true

- insert:
    - id: opensandbox-world
      name: '@codebam/dsh-opensandbox'
      config:
        # Connection (or set OPEN_SANDBOX_API_KEY / OPEN_SANDBOX_DOMAIN in dsh's environment).
        apiKeyFile: /run/user/1000/opensandbox/api-key
        domain: 127.0.0.1:8090

        # Sandbox image and workspace.
        image: docker.io/library/debian:bookworm-slim
        workspaceRoot: /home/your-user/project
        extraReadOnlyMounts:
          - /nix/store

        # Limits and lifetime.
        timeoutSeconds: 43200
        cpu: "4"
        memory: 8Gi
```

Relative `name` values resolve from dsh's profile `node_modules`, where `npm install
@codebam/dsh-opensandbox` places the package. An absolute path to `index.mjs` also works.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `OPEN_SANDBOX_API_KEY` | Lifecycle/execd API key. |
| `apiKeyFile` | `OPEN_SANDBOX_API_KEY_FILE` | File holding the API key; read at startup. |
| `domain` | `OPEN_SANDBOX_DOMAIN` or `localhost:8080` | Lifecycle host, optionally with port. |
| `protocol` | `OPEN_SANDBOX_PROTOCOL` or `http` | `http` or `https`. |
| `image` | `docker.io/library/debian:bookworm-slim` | Sandbox image URI. Pin a digest in production. |
| `workspaceRoot` | `process.cwd()` | Host directory mounted read-write at the same path. |
| `extraReadOnlyMounts` | `["/nix/store"]` | Extra host dirs mounted read-only at the same path. An empty list means this default, because the loader materializes an absent optional array as `[]`. |
| `timeoutSeconds` | `43200` | Sandbox TTL; the server minimum is 60. |
| `requestTimeoutMs` | `300000` | Lifecycle HTTP timeout. |
| `sandboxWaitMs` | `180000` | Max wait for a new sandbox to report `Running`. |
| `commandTimeoutMs` | `0` (disabled) | Optional execd-side per-command timeout. |
| `cpu` / `memory` | `"4"` / `"8Gi"` | Container resource limits. |
| `home` | `/root` | Container `HOME`. |

## What runs where

- One sandbox is created lazily per workspace root for the life of the dsh process.
- Setup, cleanup, and usage are recorded in the sandbox metadata (`codebam.dsh.workspace`).
- The container `PATH` is the host `PATH` restricted to directories a mount makes visible, plus
  `/run/current-system/sw/bin`, `/etc/profiles/per-user/$USER/bin` and `~/.nix-profile/bin` when
  they exist. That fallback matters because a dsh started by a systemd user unit inherits systemd's
  minimal `PATH`, which carries no `/nix/store` entries at all.
- `danger-full-access` still runs in the OpenSandbox world; the plugin never falls back to host
  execution.
- Confined modes report `enforcement: "partial"`, because the container bounds host file effects
  but does not re-express workspace-only/read-only semantics inside the container. The host-side
  `ctx.fs` fence still enforces workspace writes for the model's file tools.
- A read-only store means `nix build` cannot add paths from inside the sandbox; mount the host's
  `nix/var/nix/daemon-socket` too (and accept what that grants) if containerized builds are wanted.

## Publishing

```bash
npm run check
npm pack --dry-run
npm publish --access public
```

The package name is scoped and `publishConfig.access` is `public`, so the explicit flag is only a
reminder.

## Development

```bash
npm install
npm run check
```

There is no build step: the published files are the same ESM files dsh loads.

`npm test` runs a mock E2E over an in-process fake OpenSandbox server (it asserts the
execd request schema, SSE framing, metadata labels, and PTY frames). It imports
`@deepseek-ai/cordis`, which dsh provides at runtime and npm cannot fetch, so point the
checkout at any dsh install's modules first:

```bash
ln -sfn "$DSH_HOME/profiles/node_modules" node_modules   # DSH_HOME defaults to ~/.dsh
npm test
```

## License

MIT

OpenSandbox and DeepSeek Harness are separate projects with their own licenses. This plugin talks
to OpenSandbox over its HTTP/WebSocket APIs and mounts the dsh capability seams provided by the
harness.
