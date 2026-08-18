# @deepseek-ai/dsh-game

English | [中文](README.zh.md)

This Service Definition and registry owns `ctx.games`. Local Providers register bounded UTF-8 HTML, CSS, and JavaScript assets under a stable kebab-case game id. Consumers receive a `dsh-game://localhost/<sha256>/index.html` entry URL; they never receive a provider filesystem path.

## Provider registration

```ts ignore-check
ctx.games.register({
  id: GameId('example'),
  title: 'Example',
  assets: [
    { path: 'index.html', contentType: 'text/html; charset=utf-8', body: html },
    { path: 'game.js', contentType: 'text/javascript; charset=utf-8', body: script },
  ],
})
```

Registration is an effect: disposing the Provider removes its id and makes the digest unavailable to new asset requests. Every asset is limited to 512 KiB and one game to 2 MiB. Paths are normalized lowercase relative text; the closed media-type set contains UTF-8 HTML, CSS, and JavaScript. The registry emits `games/change` after registration or removal commits.

The private Desktop sidecar reads assets by digest and path. The registry does not expose a file server, network route, model tool, or arbitrary local path.

## Model Experience

None, as this registry serves only human-played Desktop companion content.

#### KV Cache effect

None; game registrations and asset reads never assemble a model request.

## Known Limitations and Deferred Work

- **Text assets only** — Providers cannot register images, audio, WebAssembly, or other binary assets; a Provider must use CSS and self-contained UTF-8 resources.
- **Desktop transport only** — The shipped consumer uses the Tauri custom protocol; Web and headless profiles can host the registry but have no presentation Provider.
