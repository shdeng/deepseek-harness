# Agent Note: Desktop game companion and local game Providers

Status: implemented

[中文](2026-08-17-desktop-game-companion-and-local-providers.zh.md)

## Problem

Long-running Harness work leaves the operator waiting, but the Bilibili companion cannot safely host an interactive game. Games need durable in-window state, input blocking when the Agent needs attention, multiple assets, and a provider identity independent of one remote URL. Loading a game in the main WebView would also give entertainment code unnecessary proximity to Session data and application IPC.

## Decision

**A Host game registry separates game Providers from Desktop presentation.** `@deepseek-ai/dsh-game` owns `ctx.games`; Provider plugins synchronously register a stable kebab-case id, bounded title, and a self-contained UTF-8 HTML/CSS/JavaScript asset set. The registry validates normalized paths, closed media types, per-asset and per-game byte limits, and the required `index.html`, then mints a SHA-256 revision URL. Provider disposal removes both the id and digest mapping and emits `games/change` after the mutation commits.

**The private Desktop protocol serves game assets without filesystem paths.** The Node sidecar answers `game-asset-read` by digest and normalized path. Rust accepts only `dsh-game://localhost/<sha256>/index.html` as a game entry, maps it to the platform custom-protocol form, and owns a separate `game-companion` WebView. The window denies other top-level navigation, downloads, and new windows. Its label appears in no Tauri capability, so game content has no Harness commands, events, Session transport, filesystem, or subprocess access.

**One companion plugin owns an exclusive live setting.** `@deepseek-ai/dsh-game-companion` registers the `companion` settings namespace over its `mode: off | bilibili | game` composition base. The Plugins settings card writes that namespace and mode changes reconcile immediately. Game mode sends `hidden`/`playable`/`attention` state, Bilibili mode sends active/inactive media intent, and off keeps both inactive. A pending `approval/request` pauses either mode. The Desktop profile mounts the registry, 2048 Provider, and companion with `mode: off`.

**2048 proves the Provider and presentation contracts.** `@deepseek-ai/dsh-game-2048` contributes an offline keyboard-operable game with visible focus, live status, reduced-motion behavior, and isolated-origin local storage. Host state events block game movement outside `playable`. The Desktop release carries the registry, Provider, and Consumer packages but does not mount their rows by default.

## Alternatives considered

**Reuse the Bilibili media request with a game URL.** Rejected because its boolean playback intent cannot express completion or approval attention, and accepting arbitrary game URLs would weaken a deliberately Bilibili-specific navigation policy.

**Compile 2048 directly into the Rust shell.** Rejected because every new game would require a Desktop release and would not exercise a plugin Provider lifecycle. Content-addressed Host assets keep window authority in Rust while letting local plugins own game content.

**Render the game inside the main Harness WebView.** Rejected because the main window carries application commands, events, and Session transport. A separate capability-free label keeps entertainment content outside that authority.

**Launch an external game process.** Rejected for the initial Provider because external applications do not offer reliable pause, input blocking, save, resource ownership, or process-tree cleanup across platforms.

## Consequences

Operators can opt into a local 2048 window that is playable only while at least one Agent works and becomes an explicit attention surface when work completes or approval is required. Game state remains local presentation data and never enters the Session log or model context.

The registry currently accepts text web assets only, and the Desktop carrier is the only presentation Provider. User-question waits remain indistinguishable from ordinary running activity because `ctx.userQuestions` publishes no live pending event; the companion pauses them only when the Agent later becomes idle.

Focused tests boot the real registry, 2048 Provider, and companion through Loader with a fake Desktop service; browser tests exercise movement, attention blocking, persistence, and accessibility state; private-protocol and Rust tests pin digest/path validation, closed native intents, navigation policy, state injection, and window capability isolation.
