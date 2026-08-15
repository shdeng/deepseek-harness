# bundle/ — profile plugin bundles

English | [中文](README.zh.md)

Profile bundles: npm packages whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, making them installable patch layers for `dsh --profile` compositions ([profile contract](../boot/app-boot/README.md#profiles)). A bundle's substance is its patch list; some also ship runtime glue plugins their patch mounts.

| Package | Role | ctx key |
|---|---|---|
| [`base/`](base/README.md) | The shared dsh core every profile applies first | — (patch only) |
| [`llm-multi-provider/`](llm-multi-provider/README.md) | Optional pi-ai provider routes for multi-provider profiles | — (patch only) |
| [`gui-app/`](gui-app/README.md) | Shared graphical Host and client composition; no network listener | — (patch only) |
| [`web-app/`](web-app/README.md) | Browser transport: HTTP/WebSocket/static/HMR rows + runtime glue | mounts rows |
| [`desktop-app/`](desktop-app/README.md) | Desktop-only native-provider selection; no Web transport | — (patch only) |
| [`headless/`](headless/README.md) | Direct one-shot task mode over base, with no Host or Web layer | mounts `headless-runner` |

In-box bundles resolve from the dsh installation; out-of-tree bundles install into a profile through `dsh plugin --profile <name> add <package>`.
