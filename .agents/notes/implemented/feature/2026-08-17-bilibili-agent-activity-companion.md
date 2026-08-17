# Agent Note: Bilibili companion driven by agent activity

Status: implemented

English | [中文](2026-08-17-bilibili-agent-activity-companion.zh.md)

## Problem

A long Harness task leaves the operator waiting through model requests and tool execution, but ordinary browser playback has no reliable relationship to that work. Reusing a personal browser tab risks changing unrelated signed-in state, while a window without lifecycle ownership can keep playing after the task ends. Concurrent sessions also make a per-turn toggle incorrect: one session can finish while another is still running.

## Decision

**One opt-in Host plugin drives one Rust-owned Tauri WebView.** `@deepseek-ai/dsh-bilibili-companion` depends on `ctx.desktopNative` and sends only a configured Bilibili URL plus the complete active/inactive state. The Desktop release includes the package without mounting it in the shipped profile. Rust creates the `bilibili-companion` window hidden, preserves operator-selected Bilibili navigation between state changes, and recreates the configured URL after the window is closed. The package is Desktop-only; Web and headless profiles cannot mount it.

**Aggregate `agent/status` is the playback authority.** The plugin maintains the set of agents whose public status is `running`. A transition from zero to any running agent asks Rust to show, focus, and play; the transition back to zero asks Rust to pause and hide. Agent disposal removes its claim. Playback is transient presentation state with no replay or model-context meaning, so this adds no Session event and does not change `agent-loop`.

**The native operation is closed and capability-free from remote content.** The Node-to-Rust request carries `{ url, active }`, never a script, arbitrary window label, or generic command. Rust validates the URL again, accepts only credential-free Bilibili HTTPS top-level navigation, denies downloads, and redirects allowed new-window requests into the same WebView. Only the main window label appears in the Tauri IPC capability; the remote Bilibili window receives no Harness command or event permissions. Rust injects one fixed play/pause helper and owns window creation, visibility, focus, navigation, and teardown with the application.

## Alternatives considered

**Launch a dedicated Chromium process and control one CDP page target.** Rejected because Bilibili navigation can create or replace browser targets independently of the Host, while window focus, user-selected tabs, profiles, and process teardown remain external state. Page-script popup interception cannot make that lifecycle authoritative.

**Control the operator's existing default-browser tab.** Rejected because the plugin could pause the wrong tab, alter an unrelated browser profile, or depend on remote debugging that was not enabled when that browser started.

**Embed Bilibili inside the main Harness WebView.** Rejected because remote site content must not share the main window label or its Tauri IPC capability. A separate label and navigation fence preserve the security split.

**Listen to durable `turn/start` and `turn/end` events.** Rejected because presentation state does not belong in replay, and separate sessions can overlap. The live registry status already defines whole-agent activity and supplies exact process-local subjects for aggregation.

**Launch one window per agent.** Rejected because concurrent sessions would create competing audio and focus changes; the operator needs one watching surface while the Harness has work.

## Consequences

The default opt-in configuration creates one hidden Bilibili WebView, shows and plays it while at least one agent works, and pauses and hides it after all work becomes idle. The operator can select other Bilibili content without leaving the native window. Non-Bilibili navigation and downloads are denied, and no arbitrary remote page can call Harness IPC.

Focused tests boot a real `cordis.yml` through Loader against a fake `DesktopNative`, then assert initial idleness, overlapping agents, final idleness, bounded failure, and disposal intent. TypeScript protocol tests pin the closed native frame. Rust tests pin URL policy, main-window-only capabilities, playback intent, and process lifecycle; the Tauri development application provides the assembled-window verification. The package invariant companion is intentionally empty because authoritative window state lives in Rust and is not readable by the Host.
