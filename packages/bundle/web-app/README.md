# `@deepseek-ai/dsh-web-app`

English | [中文](README.zh.md)

The browser-transport bundle applied after [`dsh-gui-app`](../gui-app/README.md). The shared bundle owns the graphical Host services, workspace/session composition, client-module registry, and client plugin roster. This package adds only Web carriage and Web runtime policy: the webserver, HTTP `/api`, WebSocket downlinks, `/plugins` client assets, frontend-static fallback, [`dsh-client-hmr`](../../client/hmr/README.md), browser trust, `web-startup`, and this package's `web-runtime` glue (`{printUrl, surfaceContext, trustedHosts}`). The runtime resolves the built frontend dist through `@deepseek-ai/dsh-web-frontend`, samples bind-dependent LAN trust once, provides it to the trust fence, registers the Harness-source and Web-surface prompt sections plus `DSH_WEB_URL` when `surfaceContext` is true, and prints the `dsh web:` URL only after its Loader tree settles. `web-startup` parses `--host`, `--port`, repeatable `--trusted-host`, and `--help`; it rejects `--host 0.0.0.0` before any server binds. The Desktop profile does not mount this bundle.

## Model Experience

### Harness-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory, and the `app:web-surface` global section (order −98) orients the model to the GUI: the canonical local URL, the "this page" referent, the update contract (the reload receiver is always on; no-refresh reloads additionally need the `pnpm run dev:web` watcher), and the instruction not to start replacement servers. `DSH_WEB_URL` additionally appears in the managed bash environment with its description, resolved per invocation from the live server. When it is false, neither section nor the variable is registered.

#### Token effect

One source line and one prompt paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

The prompt section sits near the system prompt's head and is stable for the life of the process (the port is a boot fact), so it does not invalidate the cache across turns.

## Known Limitations and Deferred Work

- **The frontend dist must be built** — `require.resolve` of the dist fails loud at activation with a build hint; there is no source-serving fallback.
- **`lanAddresses` is a boot-time snapshot** — interface changes after boot are not re-advertised; the printed LAN URL always matches the configured trust fence.
