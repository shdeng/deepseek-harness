#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc;
mod update;

use std::{
    collections::VecDeque,
    env,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use command_group::{CommandGroup, GroupChild};
use ipc::{
    validate_asset_digest, validate_game_asset_path, validate_game_url, validate_media_url,
    webview_boot_manifest, DesktopRequest, GameAttentionReason, GameCompanionMode, NativeRequest,
    ProtocolLine, SidecarBridge,
};
use tauri::{
    http,
    webview::{NewWindowResponse, PageLoadEvent},
    Manager, RunEvent, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const DESKTOP_INITIALIZATION_SCRIPT: &str = r#"
window.__DSH_DESKTOP_IPC__ = true;
(() => {
  const showStatus = (message) => {
    const render = () => {
      const root = document.getElementById('root');
      if (root !== null && root.childElementCount === 0) root.textContent = String(message);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', render, { once: true });
    } else {
      render();
    }
  };
  window.__DSH_DESKTOP_SET_STATUS__ = showStatus;
  window.addEventListener('error', (event) => {
    showStatus(event.error?.message ?? event.message ?? 'Desktop UI failed to start');
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    showStatus(event.reason?.message ?? event.reason ?? 'Desktop UI failed to start');
  });
})();
"#;
const MEDIA_WINDOW_LABEL: &str = "bilibili-companion";
const GAME_WINDOW_LABEL: &str = "game-companion";
const MEDIA_INITIALIZATION_SCRIPT: &str = r#"
(() => {
  window.__DSH_MEDIA_PLAYING__ = false;
  const apply = () => {
    const video = document.querySelector('video');
    if (video === null) return;
    if (window.__DSH_MEDIA_PLAYING__ === true) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  };
  window.__DSH_MEDIA_SET_PLAYING__ = (playing) => {
    window.__DSH_MEDIA_PLAYING__ = playing === true;
    apply();
  };
  document.addEventListener('DOMContentLoaded', apply, { once: true });
  new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
})();
"#;
const GAME_INITIALIZATION_SCRIPT: &str = r#"
(() => {
  window.__DSH_GAME_STATE__ = { mode: 'hidden', activeAgentCount: 0 };
  window.__DSH_GAME_SET_STATE__ = (state) => {
    window.__DSH_GAME_STATE__ = Object.freeze({ ...state });
    document.dispatchEvent(new CustomEvent('dsh-game-state', { detail: window.__DSH_GAME_STATE__ }));
  };
})();
"#;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::watch;

const STDERR_TAIL_LINES: usize = 40;
const DEFAULT_HOST_SHUTDOWN_GRACE_MS: u64 = 7_000;
const MAX_HOST_SHUTDOWN_GRACE_MS: u64 = 60_000;
const HOST_SHUTDOWN_GRACE_ENV: &str = "DSH_DESKTOP_SHUTDOWN_GRACE_MS";
const SUPERVISED_STDIN_ENV: &str = "DSH_SHUTDOWN_ON_STDIN_EOF";
const DESKTOP_SIDECAR_ENV: &str = "DSH_DESKTOP_SIDECAR";
static ASSET_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
struct HostLaunch {
    node: PathBuf,
    cli: PathBuf,
    cwd: PathBuf,
    shutdown_grace: Duration,
    credential_library: PathBuf,
}

impl HostLaunch {
    fn resolve(app: &tauri::AppHandle) -> Result<Self, String> {
        let tauri_resource_dir = app.path().resource_dir().map_err(|error| {
            format!("failed to resolve the desktop resource directory: {error}")
        })?;
        let executable_dir = env::current_exe()
            .map_err(|error| format!("failed to resolve the desktop executable: {error}"))?
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "desktop executable has no parent directory".to_owned())?;
        let resource_dir =
            dunce::simplified(&packaged_resource_dir(&tauri_resource_dir, &executable_dir))
                .to_path_buf();
        let packaged_node =
            resource_dir
                .join("runtime")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
        let packaged_host = resource_dir.join("host");
        let credential_library_name = if cfg!(windows) {
            "dsh_credential_store.dll"
        } else if cfg!(target_os = "macos") {
            "libdsh_credential_store.dylib"
        } else {
            "libdsh_credential_store.so"
        };
        let packaged_credential_library =
            resource_dir.join("runtime").join(credential_library_name);
        let development_credential_library = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../native-credential-store/target/debug")
            .join(credential_library_name);
        let packaged_cli = packaged_host.join("lib/bin.js");
        let node = env::var_os("DSH_DESKTOP_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if packaged_node.is_file() {
                    packaged_node
                } else {
                    PathBuf::from("node")
                }
            });
        let default_cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../cli/lib/bin.js");
        let launch_dir = env::current_dir()
            .map_err(|error| format!("failed to resolve the launch directory: {error}"))?;
        let cli = absolute_path(
            env::var_os("DSH_DESKTOP_CLI")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    if packaged_cli.is_file() {
                        packaged_cli.clone()
                    } else {
                        default_cli
                    }
                }),
            &launch_dir,
        );
        let cwd = env::var_os("DSH_DESKTOP_CWD")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if cli == packaged_cli {
                    packaged_host
                } else {
                    launch_dir
                }
            });

        if !cli.is_file() {
            return Err(format!(
                "built CLI not found at {}. Run `pnpm run build` or set DSH_DESKTOP_CLI",
                cli.display()
            ));
        }

        let shutdown_grace = resolve_shutdown_grace()?;
        let credential_library = if packaged_credential_library.is_file() {
            packaged_credential_library
        } else {
            development_credential_library
        };
        if !credential_library.is_file() {
            return Err(format!(
                "desktop credential library not found at {}. Run `pnpm --dir apps/desktop prepare:native`",
                credential_library.display()
            ));
        }
        Ok(Self {
            node,
            cli,
            cwd,
            shutdown_grace,
            credential_library,
        })
    }

    fn spawn(&self) -> Result<HostProcess, String> {
        let mut command = Command::new(&self.node);
        command
            // Cordis Loader exposes its module map only through this explicit
            // Node opt-in; config-only HMR uses that map in release profiles.
            .arg("--expose-internals")
            .arg(&self.cli)
            .args(["--profile", "desktop"])
            .current_dir(&self.cwd)
            .env(SUPERVISED_STDIN_ENV, "1")
            .env(DESKTOP_SIDECAR_ENV, "1")
            .env("DSH_DESKTOP_CREDENTIAL_LIBRARY", &self.credential_library)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        spawn_process_group(&mut command)
            .map(|child| HostProcess {
                child,
                shutdown_grace: self.shutdown_grace,
            })
            .map_err(|error| {
                format!(
                    "failed to start Node Host with {}: {error}",
                    self.node.display()
                )
            })
    }
}

fn packaged_resource_dir(tauri_resource_dir: &Path, executable_dir: &Path) -> PathBuf {
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let contains_host = |directory: &Path| {
        directory.join("runtime").join(node_name).is_file()
            && directory.join("host/lib/bin.js").is_file()
    };
    if contains_host(tauri_resource_dir) {
        tauri_resource_dir.to_path_buf()
    } else if contains_host(executable_dir) {
        executable_dir.to_path_buf()
    } else {
        tauri_resource_dir.to_path_buf()
    }
}

#[derive(Debug)]
struct HostProcess {
    child: GroupChild,
    shutdown_grace: Duration,
}

impl HostProcess {
    fn try_wait_leader(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child.inner().try_wait()
    }

    fn wait_for_tree(&mut self) -> Result<(), String> {
        self.child
            .wait()
            .map(drop)
            .map_err(|error| format!("failed to reap Node Host process tree: {error}"))
    }

    fn force_terminate(&mut self) -> Result<(), String> {
        let kill_error = self.child.kill().err().filter(|error| {
            !matches!(
                error.kind(),
                std::io::ErrorKind::InvalidInput | std::io::ErrorKind::NotFound
            )
        });
        let wait_result = self.wait_for_tree();
        if let Some(error) = kill_error {
            return Err(format!(
                "failed to terminate Node Host process tree: {error}"
            ));
        }
        wait_result
    }

    fn shutdown(&mut self, bridge: Option<&SidecarBridge>) -> Result<bool, String> {
        if let Some(bridge) = bridge {
            if bridge.request_shutdown().is_err() {
                bridge.close_writer();
            }
        } else {
            drop(self.child.inner().stdin.take());
        }
        let deadline = Instant::now() + self.shutdown_grace;
        loop {
            match self.try_wait_leader() {
                Ok(Some(_)) => {
                    self.wait_for_tree()?;
                    return Ok(false);
                }
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(25));
                }
                Ok(None) => break,
                Err(error) => {
                    let cleanup = self.force_terminate();
                    return Err(match cleanup {
                        Ok(()) => format!(
                            "failed to query Node Host process tree; terminated it instead: {error}"
                        ),
                        Err(cleanup_error) => format!(
                            "failed to query Node Host process tree: {error}; {cleanup_error}"
                        ),
                    });
                }
            }
        }

        bridge.inspect(|bridge| bridge.close_writer());
        self.force_terminate()?;
        Ok(true)
    }
}

fn resolve_shutdown_grace() -> Result<Duration, String> {
    match env::var(HOST_SHUTDOWN_GRACE_ENV) {
        Ok(value) => parse_shutdown_grace_ms(&value),
        Err(env::VarError::NotPresent) => Ok(Duration::from_millis(
            DEFAULT_HOST_SHUTDOWN_GRACE_MS,
        )),
        Err(env::VarError::NotUnicode(_)) => Err(format!(
            "{HOST_SHUTDOWN_GRACE_ENV} must be a Unicode integer between 1 and {MAX_HOST_SHUTDOWN_GRACE_MS}"
        )),
    }
}

fn parse_shutdown_grace_ms(value: &str) -> Result<Duration, String> {
    let milliseconds = value.parse::<u64>().map_err(|_| {
        format!(
            "{HOST_SHUTDOWN_GRACE_ENV} must be an integer between 1 and {MAX_HOST_SHUTDOWN_GRACE_MS}, got {value:?}"
        )
    })?;
    if !(1..=MAX_HOST_SHUTDOWN_GRACE_MS).contains(&milliseconds) {
        return Err(format!(
            "{HOST_SHUTDOWN_GRACE_ENV} must be between 1 and {MAX_HOST_SHUTDOWN_GRACE_MS}, got {milliseconds}"
        ));
    }
    Ok(Duration::from_millis(milliseconds))
}

#[cfg(windows)]
fn spawn_process_group(command: &mut Command) -> std::io::Result<GroupChild> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command
        .group()
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true)
        .spawn()
}

#[cfg(not(windows))]
fn spawn_process_group(command: &mut Command) -> std::io::Result<GroupChild> {
    command.group_spawn()
}

#[derive(Debug, Default)]
struct NavigationFence {
    #[cfg(debug_assertions)]
    development_url: Option<Url>,
}

impl NavigationFence {
    fn new(development_url: Option<Url>) -> Self {
        #[cfg(debug_assertions)]
        {
            Self { development_url }
        }
        #[cfg(not(debug_assertions))]
        {
            let _ = development_url;
            Self {}
        }
    }

    fn allows(&self, url: &Url) -> bool {
        if url.scheme() == "tauri" {
            return true;
        }
        if matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost") {
            return true;
        }
        #[cfg(debug_assertions)]
        if self
            .development_url
            .as_ref()
            .is_some_and(|development_url| development_url.origin() == url.origin())
        {
            return true;
        }
        false
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
struct MediaCompanionDesired {
    configured_url: Option<Url>,
    active: bool,
}

#[derive(Debug, Default)]
struct MediaCompanionRuntime {
    operation: Mutex<()>,
    desired: Mutex<MediaCompanionDesired>,
}

#[derive(Clone, Debug, PartialEq)]
struct GameCompanionDesired {
    configured_url: Option<Url>,
    title: String,
    mode: GameCompanionMode,
    active_agent_count: u32,
    reason: Option<GameAttentionReason>,
}

impl Default for GameCompanionDesired {
    fn default() -> Self {
        Self {
            configured_url: None,
            title: String::new(),
            mode: GameCompanionMode::Hidden,
            active_agent_count: 0,
            reason: None,
        }
    }
}

#[derive(Debug, Default)]
struct GameCompanionRuntime {
    operation: Mutex<()>,
    desired: Mutex<GameCompanionDesired>,
}

fn media_navigation_allowed(url: &Url) -> bool {
    url.as_str() == "about:blank" || validate_media_url(url.as_str()).is_ok()
}

fn media_playback_script(active: bool) -> String {
    format!(
        "window.__DSH_MEDIA_SET_PLAYING__?.({});",
        if active { "true" } else { "false" }
    )
}

fn apply_media_playback(window: &WebviewWindow, active: bool) -> Result<(), String> {
    window
        .eval(media_playback_script(active))
        .map_err(|error| format!("failed to control Bilibili playback: {error}"))
}

fn build_media_window(
    app: &tauri::AppHandle,
    runtime: Arc<MediaCompanionRuntime>,
    url: Url,
) -> Result<WebviewWindow, String> {
    let popup_app = app.clone();
    let page_runtime = Arc::clone(&runtime);
    WebviewWindowBuilder::new(app, MEDIA_WINDOW_LABEL, WebviewUrl::External(url))
        .initialization_script(MEDIA_INITIALIZATION_SCRIPT)
        .title("Bilibili Companion")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 640.0)
        .visible(false)
        .on_navigation(media_navigation_allowed)
        .on_new_window(move |url, _features| {
            if validate_media_url(url.as_str()).is_ok() {
                let task_app = popup_app.clone();
                let schedule = popup_app.clone();
                let _ = schedule.run_on_main_thread(move || {
                    if let Some(window) = task_app.get_webview_window(MEDIA_WINDOW_LABEL) {
                        let _ = window.navigate(url);
                    }
                });
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let active = page_runtime
                    .desired
                    .lock()
                    .expect("media companion state lock poisoned")
                    .active;
                let _ = apply_media_playback(&window, active);
            }
        })
        .on_document_title_changed(|window, title| {
            let title = if title.trim().is_empty() {
                "Bilibili Companion".to_owned()
            } else {
                format!("{title} — Bilibili Companion")
            };
            let _ = window.set_title(&title);
        })
        .on_download(|_webview, _event| false)
        .build()
        .map_err(|error| format!("failed to create Bilibili companion window: {error}"))
}

fn reconcile_media_on_main(
    app: &tauri::AppHandle,
    runtime: &Arc<MediaCompanionRuntime>,
    url: Url,
    active: bool,
) -> Result<(), String> {
    let desired = MediaCompanionDesired {
        configured_url: Some(url.clone()),
        active,
    };
    let previous = {
        let mut state = runtime
            .desired
            .lock()
            .expect("media companion state lock poisoned");
        std::mem::replace(&mut *state, desired)
    };
    let result = (|| {
        let window = match app.get_webview_window(MEDIA_WINDOW_LABEL) {
            Some(window) => {
                if previous.configured_url.as_ref() != Some(&url) {
                    window.navigate(url).map_err(|error| {
                        format!("failed to navigate Bilibili companion: {error}")
                    })?;
                }
                window
            }
            None => build_media_window(app, Arc::clone(runtime), url)?,
        };
        if active {
            window
                .unminimize()
                .map_err(|error| format!("failed to restore Bilibili companion: {error}"))?;
            window
                .show()
                .and_then(|()| window.set_focus())
                .map_err(|error| format!("failed to show Bilibili companion: {error}"))?;
            apply_media_playback(&window, true)
        } else {
            apply_media_playback(&window, false)?;
            window
                .hide()
                .map_err(|error| format!("failed to hide Bilibili companion: {error}"))
        }
    })();
    if result.is_err() {
        *runtime
            .desired
            .lock()
            .expect("media companion state lock poisoned") = previous;
    }
    result
}

fn reconcile_media_companion(app: &tauri::AppHandle, url: Url, active: bool) -> Result<(), String> {
    let runtime = app.state::<Arc<MediaCompanionRuntime>>().inner().clone();
    let _operation = runtime
        .operation
        .lock()
        .expect("media companion operation lock poisoned");
    let task_app = app.clone();
    let task_runtime = Arc::clone(&runtime);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(reconcile_media_on_main(
            &task_app,
            &task_runtime,
            url,
            active,
        ));
    })
    .map_err(|error| format!("failed to schedule Bilibili companion update: {error}"))?;
    receiver
        .recv()
        .map_err(|_| "Bilibili companion update ended without a result".to_owned())?
}

fn game_navigation_allowed(url: &Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if url.scheme() == "dsh-game" {
        return validate_game_url(url.as_str()).is_ok();
    }
    if url.scheme() == "http" && url.host_str() == Some("dsh-game.localhost") {
        let local = format!("dsh-game://localhost{}", url.path());
        return validate_game_url(&local).is_ok();
    }
    false
}

fn game_return_navigation(url: &Url) -> bool {
    let path = if url.scheme() == "dsh-game" && url.host_str() == Some("localhost") {
        url.path()
    } else if url.scheme() == "http" && url.host_str() == Some("dsh-game.localhost") {
        url.path()
    } else {
        return false;
    };
    let Some((digest, action)) = path.strip_prefix('/').and_then(|path| path.split_once('/'))
    else {
        return false;
    };
    validate_asset_digest(digest).is_ok() && action == "return-to-harness"
}

fn game_webview_url(url: &Url) -> Result<Url, String> {
    if cfg!(any(target_os = "windows", target_os = "android")) {
        return Url::parse(&format!("http://dsh-game.localhost{}", url.path()))
            .map_err(|error| format!("failed to map game companion URL: {error}"));
    }
    Ok(url.clone())
}

fn game_state_script(desired: &GameCompanionDesired) -> String {
    let mode = match desired.mode {
        GameCompanionMode::Hidden => "hidden",
        GameCompanionMode::Playable => "playable",
        GameCompanionMode::Attention => "attention",
    };
    let reason = desired.reason.map(|reason| match reason {
        GameAttentionReason::WorkComplete => "work-complete",
        GameAttentionReason::Approval => "approval",
    });
    let state = serde_json::json!({
        "mode": mode,
        "activeAgentCount": desired.active_agent_count,
        "reason": reason,
    });
    format!("window.__DSH_GAME_SET_STATE__?.({state});")
}

fn apply_game_state(window: &WebviewWindow, desired: &GameCompanionDesired) -> Result<(), String> {
    window
        .eval(game_state_script(desired))
        .map_err(|error| format!("failed to update game companion state: {error}"))
}

fn build_game_window(
    app: &tauri::AppHandle,
    runtime: Arc<GameCompanionRuntime>,
    url: &Url,
    title: &str,
) -> Result<WebviewWindow, String> {
    let page_runtime = Arc::clone(&runtime);
    let navigation_app = app.clone();
    WebviewWindowBuilder::new(
        app,
        GAME_WINDOW_LABEL,
        WebviewUrl::External(game_webview_url(url)?),
    )
    .initialization_script(GAME_INITIALIZATION_SCRIPT)
    .title(format!("{title} — DeepSeek Harness"))
    .inner_size(620.0, 760.0)
    .min_inner_size(380.0, 620.0)
    .visible(false)
    .on_navigation(move |url| {
        if !game_return_navigation(url) {
            return game_navigation_allowed(url);
        }
        if let Some(game) = navigation_app.get_webview_window(GAME_WINDOW_LABEL) {
            let _ = game.hide();
        }
        if let Some(main) = navigation_app.get_webview_window("main") {
            let _ = main.show().and_then(|()| main.set_focus());
        }
        false
    })
    .on_new_window(|_url, _features| NewWindowResponse::Deny)
    .on_page_load(move |window, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            let desired = page_runtime
                .desired
                .lock()
                .expect("game companion state lock poisoned")
                .clone();
            let _ = apply_game_state(&window, &desired);
        }
    })
    .on_download(|_webview, _event| false)
    .build()
    .map_err(|error| format!("failed to create game companion window: {error}"))
}

fn reconcile_game_on_main(
    app: &tauri::AppHandle,
    runtime: &Arc<GameCompanionRuntime>,
    desired: GameCompanionDesired,
) -> Result<(), String> {
    let url = desired
        .configured_url
        .clone()
        .ok_or_else(|| "game companion desired state has no URL".to_owned())?;
    let previous = {
        let mut state = runtime
            .desired
            .lock()
            .expect("game companion state lock poisoned");
        std::mem::replace(&mut *state, desired.clone())
    };
    let result = (|| {
        let window = match app.get_webview_window(GAME_WINDOW_LABEL) {
            Some(window) => {
                if previous.configured_url.as_ref() != Some(&url) {
                    window
                        .navigate(game_webview_url(&url)?)
                        .map_err(|error| format!("failed to navigate game companion: {error}"))?;
                }
                window
                    .set_title(&format!("{} — DeepSeek Harness", desired.title))
                    .map_err(|error| format!("failed to title game companion: {error}"))?;
                window
            }
            None => build_game_window(app, Arc::clone(runtime), &url, &desired.title)?,
        };
        apply_game_state(&window, &desired)?;
        match desired.mode {
            GameCompanionMode::Hidden => window
                .hide()
                .map_err(|error| format!("failed to hide game companion: {error}")),
            GameCompanionMode::Playable | GameCompanionMode::Attention => window
                .unminimize()
                .and_then(|()| window.show())
                .and_then(|()| window.set_focus())
                .map_err(|error| format!("failed to show game companion: {error}")),
        }
    })();
    if result.is_err() {
        *runtime
            .desired
            .lock()
            .expect("game companion state lock poisoned") = previous;
    }
    result
}

fn reconcile_game_companion(
    app: &tauri::AppHandle,
    url: Url,
    title: String,
    mode: GameCompanionMode,
    active_agent_count: u32,
    reason: Option<GameAttentionReason>,
) -> Result<(), String> {
    let runtime = app.state::<Arc<GameCompanionRuntime>>().inner().clone();
    let _operation = runtime
        .operation
        .lock()
        .expect("game companion operation lock poisoned");
    let desired = GameCompanionDesired {
        configured_url: Some(url),
        title,
        mode,
        active_agent_count,
        reason,
    };
    let task_app = app.clone();
    let task_runtime = Arc::clone(&runtime);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(reconcile_game_on_main(&task_app, &task_runtime, desired));
    })
    .map_err(|error| format!("failed to schedule game companion update: {error}"))?;
    receiver
        .recv()
        .map_err(|_| "game companion update ended without a result".to_owned())?
}

#[derive(Clone, Debug)]
enum BootStatus {
    Starting,
    Ready(serde_json::Value),
    Failed(String),
}

#[derive(Debug)]
struct HostState {
    child: Mutex<Option<HostProcess>>,
    shutting_down: AtomicBool,
    stderr_tail: Mutex<VecDeque<String>>,
    boot: watch::Sender<BootStatus>,
    bridge: SidecarBridge,
}

impl HostState {
    fn new() -> Self {
        let (boot, _) = watch::channel(BootStatus::Starting);
        Self {
            child: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
            stderr_tail: Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)),
            boot,
            bridge: SidecarBridge::new(),
        }
    }

    fn start(self: &Arc<Self>, app: tauri::AppHandle) -> Result<(), String> {
        let launch = HostLaunch::resolve(&app)?;
        let mut child = launch.spawn()?;
        let Some(stdout) = child.child.inner().stdout.take() else {
            let _ = child.force_terminate();
            return Err("Node Host stdout pipe was not created".to_owned());
        };
        let Some(stderr) = child.child.inner().stderr.take() else {
            let _ = child.force_terminate();
            return Err("Node Host stderr pipe was not created".to_owned());
        };
        let Some(stdin) = child.child.inner().stdin.take() else {
            let _ = child.force_terminate();
            return Err("Node Host stdin pipe was not created".to_owned());
        };
        self.bridge.install_writer(stdin);
        *self.child.lock().expect("Host child lock poisoned") = Some(child);

        let stdout_state = Arc::clone(self);
        let stdout_app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        match stdout_state.bridge.handle_line(&stdout_app, &line) {
                            Ok(ProtocolLine::Ready(manifest)) => {
                                stdout_state.publish_ready(manifest);
                                continue;
                            }
                            Ok(ProtocolLine::NativeRequest(request)) => {
                                let native_state = Arc::clone(&stdout_state);
                                let native_app = stdout_app.clone();
                                thread::spawn(move || {
                                    let (id, result) = match request {
                                        NativeRequest::PickDirectory { id } => {
                                            let result = pick_directory(&native_app)
                                                .map(serde_json::Value::from);
                                            (id, result)
                                        }
                                        NativeRequest::CaptureCredential { id, credential } => {
                                            let result = capture_credential(&credential)
                                                .map(serde_json::Value::from);
                                            (id, result)
                                        }
                                        NativeRequest::OpenExternal { id, url } => {
                                            let result = open_external(&url)
                                                .map(|()| serde_json::Value::Null);
                                            (id, result)
                                        }
                                        NativeRequest::Notify { id, title, body } => {
                                            let result = notify(&native_app, &title, &body)
                                                .map(|()| serde_json::Value::Null);
                                            (id, result)
                                        }
                                        NativeRequest::MediaCompanion { id, url, active } => {
                                            let result =
                                                reconcile_media_companion(&native_app, url, active)
                                                    .map(|()| serde_json::Value::Null);
                                            (id, result)
                                        }
                                        NativeRequest::GameCompanion {
                                            id,
                                            url,
                                            title,
                                            mode,
                                            active_agent_count,
                                            reason,
                                        } => {
                                            let result = reconcile_game_companion(
                                                &native_app,
                                                url,
                                                title,
                                                mode,
                                                active_agent_count,
                                                reason,
                                            )
                                            .map(|()| serde_json::Value::Null);
                                            (id, result)
                                        }
                                        NativeRequest::Metadata { id } => {
                                            (id, Ok(application_metadata(&native_app)))
                                        }
                                    };
                                    if let Err(error) =
                                        native_state.bridge.send_native_response(&id, result)
                                    {
                                        report_status(&native_app, &error);
                                    }
                                });
                                continue;
                            }
                            Ok(ProtocolLine::Handled) => continue,
                            Ok(ProtocolLine::NotProtocol) => {}
                            Err(error) => {
                                stdout_state.fail_boot(error.clone());
                                report_status(&stdout_app, &error);
                                break;
                            }
                        }
                        println!("[dsh-host] {line}");
                    }
                    Err(error) => {
                        report_status(
                            &stdout_app,
                            &format!("failed to read Node Host stdout: {error}"),
                        );
                        break;
                    }
                }
            }
        });

        let stderr_state = Arc::clone(self);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                match line {
                    Ok(line) => {
                        eprintln!("[dsh-host] {line}");
                        stderr_state.push_stderr(line);
                    }
                    Err(error) => {
                        stderr_state
                            .push_stderr(format!("failed to read Node Host stderr: {error}"));
                        break;
                    }
                }
            }
        });

        let watcher_state = Arc::clone(self);
        thread::spawn(move || watcher_state.watch(app));
        Ok(())
    }

    fn publish_ready(&self, manifest: serde_json::Value) {
        self.boot.send_replace(BootStatus::Ready(manifest));
    }

    fn fail_boot(&self, message: String) {
        if matches!(*self.boot.borrow(), BootStatus::Starting) {
            self.boot.send_replace(BootStatus::Failed(message));
        }
    }

    fn push_stderr(&self, line: String) {
        let mut tail = self.stderr_tail.lock().expect("Host stderr lock poisoned");
        if tail.len() == STDERR_TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line);
    }

    fn watch(&self, app: tauri::AppHandle) {
        loop {
            thread::sleep(Duration::from_millis(200));
            let status = {
                let mut child = self.child.lock().expect("Host child lock poisoned");
                let Some(child) = child.as_mut() else {
                    return;
                };
                match child.try_wait_leader() {
                    Ok(status) => status,
                    Err(error) => {
                        report_status(&app, &format!("failed to query Node Host status: {error}"));
                        return;
                    }
                }
            };
            let Some(status) = status else {
                continue;
            };
            if !self.shutting_down.load(Ordering::Acquire) {
                self.bridge
                    .fail_all(&format!("Node Host exited unexpectedly ({status})"));
                let cleanup_error = {
                    let mut child = self.child.lock().expect("Host child lock poisoned");
                    child
                        .as_mut()
                        .and_then(|child| child.force_terminate().err())
                };
                let tail = self
                    .stderr_tail
                    .lock()
                    .expect("Host stderr lock poisoned")
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");
                let mut detail = if tail.is_empty() {
                    String::new()
                } else {
                    format!("\n\nRecent Host errors:\n{tail}")
                };
                if let Some(error) = cleanup_error {
                    detail.push_str(&format!("\n\nProcess-tree cleanup failed: {error}"));
                }
                report_status(
                    &app,
                    &format!("Node Host exited unexpectedly ({status}).{detail}"),
                );
                self.fail_boot(format!("Node Host exited unexpectedly ({status}).{detail}"));
            }
            return;
        }
    }

    fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        let child = self.child.lock().expect("Host child lock poisoned").take();
        let Some(mut child) = child else {
            return;
        };
        match child.shutdown(Some(&self.bridge)) {
            Ok(true) => eprintln!(
                "[dsh-desktop] Node Host did not quiesce within {} ms; terminated its process tree",
                child.shutdown_grace.as_millis()
            ),
            Ok(false) => {}
            Err(error) => eprintln!("[dsh-desktop] {error}"),
        }
        self.bridge.close_writer();
        self.bridge.fail_all("desktop shell is shutting down");
    }
}

#[tauri::command]
async fn desktop_ipc_request(
    window: WebviewWindow,
    state: State<'_, Arc<HostState>>,
    request: DesktopRequest,
) -> Result<serde_json::Value, String> {
    state
        .bridge
        .request(request, window.label().to_owned())
        .await
}

#[tauri::command]
fn desktop_ipc_cancel(state: State<'_, Arc<HostState>>, id: String) -> Result<(), String> {
    state.bridge.cancel(&id)
}

#[tauri::command]
async fn desktop_boot_manifest(
    state: State<'_, Arc<HostState>>,
) -> Result<serde_json::Value, String> {
    let mut boot = state.boot.subscribe();
    loop {
        match boot.borrow().clone() {
            BootStatus::Ready(manifest) => {
                return webview_boot_manifest(
                    manifest,
                    cfg!(any(target_os = "windows", target_os = "android")),
                )
            }
            BootStatus::Failed(error) => return Err(error),
            BootStatus::Starting => {}
        }
        boot.changed()
            .await
            .map_err(|_| "desktop Host boot state closed before readiness".to_owned())?;
    }
}

fn absolute_path(path: PathBuf, base: &Path) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn report_status(app: &tauri::AppHandle, message: &str) {
    eprintln!("[dsh-desktop] {message}");
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let encoded = serde_json::to_string(message).expect("status string serializes as JSON");
    let _ = window.eval(format!("window.__DSH_DESKTOP_SET_STATUS__?.({encoded})"));
}

fn protocol_error(
    status: http::StatusCode,
    message: impl Into<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(http::header::CACHE_CONTROL, "no-store")
        .body(message.into())
        .expect("static custom-protocol response is valid")
}

async fn read_protocol_asset(
    host: Arc<HostState>,
    window_label: String,
    uri: http::Uri,
) -> http::Response<Vec<u8>> {
    if !matches!(uri.host(), Some("localhost" | "dsh-plugin.localhost")) {
        return protocol_error(
            http::StatusCode::FORBIDDEN,
            b"unauthorized asset authority".to_vec(),
        );
    }
    let Some(asset) = uri
        .path()
        .strip_prefix('/')
        .and_then(|path| path.strip_suffix("/client.js"))
    else {
        return protocol_error(
            http::StatusCode::NOT_FOUND,
            b"client asset not found".to_vec(),
        );
    };
    if validate_asset_digest(asset).is_err() {
        return protocol_error(
            http::StatusCode::NOT_FOUND,
            b"client asset not found".to_vec(),
        );
    }
    let id = format!(
        "asset-{}",
        ASSET_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let result = host
        .bridge
        .request(
            DesktopRequest::AssetRead {
                id,
                asset: asset.to_owned(),
            },
            window_label,
        )
        .await;
    asset_protocol_response(result)
}

async fn read_game_protocol_asset(
    host: Arc<HostState>,
    window_label: String,
    uri: http::Uri,
) -> http::Response<Vec<u8>> {
    if !matches!(uri.host(), Some("localhost" | "dsh-game.localhost")) {
        return protocol_error(
            http::StatusCode::FORBIDDEN,
            b"unauthorized game asset authority".to_vec(),
        );
    }
    let Some(path) = uri.path().strip_prefix('/') else {
        return protocol_error(
            http::StatusCode::NOT_FOUND,
            b"game asset not found".to_vec(),
        );
    };
    let Some((asset, path)) = path.split_once('/') else {
        return protocol_error(
            http::StatusCode::NOT_FOUND,
            b"game asset not found".to_vec(),
        );
    };
    if validate_asset_digest(asset).is_err() || validate_game_asset_path(path).is_err() {
        return protocol_error(
            http::StatusCode::NOT_FOUND,
            b"game asset not found".to_vec(),
        );
    }
    let id = format!(
        "game-asset-{}",
        ASSET_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let result = host
        .bridge
        .request(
            DesktopRequest::GameAssetRead {
                id,
                asset: asset.to_owned(),
                path: path.to_owned(),
            },
            window_label,
        )
        .await;
    asset_protocol_response(result)
}

fn asset_protocol_response(result: Result<serde_json::Value, String>) -> http::Response<Vec<u8>> {
    let Ok(result) = result else {
        return protocol_error(
            http::StatusCode::BAD_GATEWAY,
            result.expect_err("error branch has an error").into_bytes(),
        );
    };
    let Some(content_type) = result
        .get("contentType")
        .and_then(serde_json::Value::as_str)
    else {
        return protocol_error(
            http::StatusCode::BAD_GATEWAY,
            b"Host returned no asset media type".to_vec(),
        );
    };
    let Some(body) = result.get("body").and_then(serde_json::Value::as_str) else {
        return protocol_error(
            http::StatusCode::BAD_GATEWAY,
            b"Host returned no asset body".to_vec(),
        );
    };
    let Ok(body) = BASE64.decode(body) else {
        return protocol_error(
            http::StatusCode::BAD_GATEWAY,
            b"Host returned invalid asset bytes".to_vec(),
        );
    };
    http::Response::builder()
        .status(http::StatusCode::OK)
        .header(http::header::CONTENT_TYPE, content_type)
        .header(http::header::CACHE_CONTROL, "no-cache")
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .expect("validated custom-protocol response is valid")
}

fn pick_directory(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|selection| {
            selection
                .into_path()
                .map_err(|error| format!("selected directory is not a local path: {error}"))
                .and_then(|path| {
                    path.into_os_string()
                        .into_string()
                        .map_err(|_| "selected directory is not valid Unicode".to_owned())
                })
        })
        .transpose()
}

fn capture_credential(reference: &str) -> Result<bool, String> {
    let Some(secret) = tinyfiledialogs::password_box(
        "DeepSeek Harness credential",
        &format!("Enter the value for {reference}. It will be stored in the operating system credential vault."),
    ) else {
        return Ok(false);
    };
    dsh_credential_store::set(reference, &secret)?;
    Ok(true)
}

pub(crate) fn open_external(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|error| format!("external URL is invalid: {error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("external URL must be an absolute HTTP(S) URL without credentials".to_owned());
    }
    webbrowser::open(url.as_str())
        .map(drop)
        .map_err(|error| format!("failed to open external URL: {error}"))
}

fn notify(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    if title.is_empty() || title.len() > 128 || body.len() > 1024 {
        return Err("notification text is outside its bounds".to_owned());
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| format!("failed to show desktop notification: {error}"))
}

fn application_metadata(app: &tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "name": app.package_info().name,
        "version": app.package_info().version.to_string(),
        "identifier": app.config().identifier,
    })
}

fn accept_deep_link(app: &tauri::AppHandle, host: &HostState, url: &Url) -> Result<(), String> {
    let session_id = deep_link_session_id(url)?;
    host.bridge.send_deep_link(session_id)?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

fn deep_link_session_id(url: &Url) -> Result<&str, String> {
    if url.scheme() != "deepseek-harness"
        || url.host_str() != Some("session")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("deep link is outside the registered session URL format".to_owned());
    }
    let path = url.path().strip_prefix('/').unwrap_or_default();
    if path.is_empty()
        || path.len() > 256
        || !path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~-".contains(&byte))
    {
        return Err("deep-link session id must be bounded URL-safe ASCII".to_owned());
    }
    Ok(path)
}

fn install_deep_links(app: &tauri::AppHandle, host: Arc<HostState>) -> Result<(), String> {
    let current = app
        .deep_link()
        .get_current()
        .map_err(|error| format!("failed to read startup deep link: {error}"))?;
    if let Some(urls) = current {
        for url in urls {
            accept_deep_link(app, &host, &url)?;
        }
    }
    let event_app = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            if let Err(error) = accept_deep_link(&event_app, &host, &url) {
                report_status(&event_app, &error);
            }
        }
    });
    Ok(())
}

fn create_window(
    app: &tauri::AppHandle,
    navigation: Arc<NavigationFence>,
) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .initialization_script(DESKTOP_INITIALIZATION_SCRIPT)
        .title("DeepSeek Harness Desktop")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 640.0)
        .on_navigation(move |url| navigation.allows(url))
        .build()
}

fn main() {
    let host = Arc::new(HostState::new());
    let setup_host = Arc::clone(&host);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(MediaCompanionRuntime::default()))
        .manage(Arc::new(GameCompanionRuntime::default()))
        .register_asynchronous_uri_scheme_protocol("dsh-plugin", |context, request, responder| {
            let host = context
                .app_handle()
                .state::<Arc<HostState>>()
                .inner()
                .clone();
            let window_label = context.webview_label().to_owned();
            let uri = request.uri().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(read_protocol_asset(host, window_label, uri).await);
            });
        })
        .register_asynchronous_uri_scheme_protocol("dsh-game", |context, request, responder| {
            let host = context
                .app_handle()
                .state::<Arc<HostState>>()
                .inner()
                .clone();
            let window_label = context.webview_label().to_owned();
            let uri = request.uri().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(read_game_protocol_asset(host, window_label, uri).await);
            });
        })
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::clone(&host))
        .invoke_handler(tauri::generate_handler![
            desktop_ipc_request,
            desktop_ipc_cancel,
            desktop_boot_manifest
        ])
        .setup(move |app| {
            let navigation = Arc::new(NavigationFence::new(app.config().build.dev_url.clone()));
            create_window(app.handle(), navigation)?;
            if let Err(error) = setup_host.start(app.handle().clone()) {
                setup_host.fail_boot(error.clone());
                report_status(app.handle(), &error);
            }
            if let Err(error) = install_deep_links(app.handle(), Arc::clone(&setup_host)) {
                report_status(app.handle(), &error);
            }
            update::start_update_check(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri desktop shell");

    app.run(move |_app, event| match event {
        RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            if let Err(error) = host.bridge.cancel_window(&label) {
                eprintln!("[dsh-desktop] failed to cancel streams for closed window: {error}");
            }
            if label == GAME_WINDOW_LABEL {
                if let Some(main) = _app.get_webview_window("main") {
                    let _ = main.show().and_then(|()| main.set_focus());
                }
            }
        }
        RunEvent::ExitRequested { .. } => host.shutdown(),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::Read,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn test_marker(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock follows the Unix epoch")
            .as_nanos();
        env::temp_dir().join(format!("dsh-desktop-{name}-{}-{nonce}", std::process::id()))
    }

    fn spawn_node_fixture(script: &str, marker: &Path, grace: Duration) -> HostProcess {
        let mut command = Command::new("node");
        command
            .args(["-e", script])
            .arg(marker)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = spawn_process_group(&mut command).expect("Node fixture starts");
        let mut stdout = child
            .inner()
            .stdout
            .take()
            .expect("Node fixture stdout is piped");
        let mut ready = [0_u8; 6];
        stdout
            .read_exact(&mut ready)
            .expect("Node fixture publishes readiness");
        assert_eq!(&ready, b"ready\n");
        HostProcess {
            child,
            shutdown_grace: grace,
        }
    }

    #[test]
    fn navigation_fence_allows_only_the_tauri_application_origin() {
        let fence = NavigationFence::default();
        assert!(fence.allows(&Url::parse("tauri://localhost/").unwrap()));
        assert!(fence.allows(&Url::parse("http://tauri.localhost/").unwrap()));
        assert!(!fence.allows(&Url::parse("http://127.0.0.1:4123/").unwrap()));
        assert!(!fence.allows(&Url::parse("https://example.com/").unwrap()));
    }

    #[test]
    fn navigation_fence_allows_only_the_configured_development_origin() {
        let fence = NavigationFence::new(Some(Url::parse("http://127.0.0.1:1430/").unwrap()));
        assert!(fence.allows(&Url::parse("http://127.0.0.1:1430/session/1").unwrap()));
        assert!(!fence.allows(&Url::parse("http://127.0.0.1:1431/").unwrap()));
        assert!(!fence.allows(&Url::parse("http://localhost:1430/").unwrap()));
    }

    #[test]
    fn media_navigation_accepts_only_bilibili_and_inert_bootstrap() {
        assert!(media_navigation_allowed(
            &Url::parse("about:blank").unwrap()
        ));
        assert!(media_navigation_allowed(
            &Url::parse("https://www.bilibili.com/video/BV1x").unwrap()
        ));
        assert!(!media_navigation_allowed(
            &Url::parse("https://example.com/video/BV1x").unwrap()
        ));
        assert!(media_playback_script(true).contains("(true)"));
        assert!(media_playback_script(false).contains("(false)"));
    }

    #[test]
    fn game_navigation_and_state_are_closed_to_local_assets() {
        let digest = "a".repeat(64);
        assert!(game_navigation_allowed(
            &Url::parse(&format!("dsh-game://localhost/{digest}/index.html")).unwrap()
        ));
        assert!(game_navigation_allowed(
            &Url::parse(&format!("http://dsh-game.localhost/{digest}/index.html")).unwrap()
        ));
        assert!(!game_navigation_allowed(
            &Url::parse("https://example.com/game").unwrap()
        ));
        assert!(game_return_navigation(
            &Url::parse(&format!("dsh-game://localhost/{digest}/return-to-harness")).unwrap()
        ));
        let desired = GameCompanionDesired {
            configured_url: Some(
                Url::parse(&format!("dsh-game://localhost/{digest}/index.html")).unwrap(),
            ),
            title: "2048".to_owned(),
            mode: GameCompanionMode::Attention,
            active_agent_count: 0,
            reason: Some(GameAttentionReason::WorkComplete),
        };
        let script = game_state_script(&desired);
        assert!(script.contains("attention"));
        assert!(script.contains("work-complete"));
    }

    #[test]
    fn deep_links_accept_only_the_registered_session_url() {
        assert_eq!(
            deep_link_session_id(&Url::parse("deepseek-harness://session/session-1234").unwrap()),
            Ok("session-1234")
        );
        assert!(
            deep_link_session_id(&Url::parse("deepseek-harness://settings/").unwrap()).is_err()
        );
        assert!(deep_link_session_id(
            &Url::parse("deepseek-harness://session/session-1234?source=web").unwrap()
        )
        .is_err());
        assert!(deep_link_session_id(
            &Url::parse("https://example.com/session/session-1234").unwrap()
        )
        .is_err());
    }

    #[test]
    fn external_url_policy_rejects_non_web_and_credentialed_urls() {
        assert!(open_external("file:///etc/passwd").is_err());
        assert!(open_external("https://user:secret@example.com/").is_err());
    }

    #[test]
    fn desktop_csp_limits_dynamic_code_to_local_application_resources() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("Tauri config is JSON");
        let csp = config["app"]["security"]["csp"]
            .as_str()
            .expect("desktop CSP is configured");

        assert!(
            csp.contains("script-src 'self' 'unsafe-eval' dsh-plugin: http://dsh-plugin.localhost")
        );
        assert!(csp.contains("font-src 'self' data:"));
        assert!(csp.contains("img-src 'self' data:"));
        assert!(csp.contains("style-src 'self' 'unsafe-inline'"));
        assert!(!csp.contains("https:"));
        assert!(!csp.contains("http:;"));
        assert_eq!(
            config["app"]["security"]["capabilities"][0]["windows"],
            serde_json::json!(["main"]),
            "the media and game WebViews must not receive the main-window IPC capability"
        );
    }

    #[test]
    fn parses_bounded_shutdown_grace() {
        assert_eq!(
            parse_shutdown_grace_ms("250").expect("valid grace"),
            Duration::from_millis(250)
        );
        assert!(parse_shutdown_grace_ms("0").is_err());
        assert!(parse_shutdown_grace_ms("60001").is_err());
        assert!(parse_shutdown_grace_ms("later").is_err());
    }

    #[test]
    fn packaged_resources_fall_back_to_the_executable_directory() {
        let tauri_resources = test_marker("tauri-resources");
        let executable_dir = test_marker("executable-resources");
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        fs::create_dir_all(executable_dir.join("runtime")).expect("runtime directory");
        fs::create_dir_all(executable_dir.join("host/lib")).expect("Host directory");
        fs::write(executable_dir.join("runtime").join(node_name), []).expect("Node fixture");
        fs::write(executable_dir.join("host/lib/bin.js"), []).expect("CLI fixture");

        assert_eq!(
            packaged_resource_dir(&tauri_resources, &executable_dir),
            executable_dir
        );

        fs::remove_dir_all(&executable_dir).expect("remove executable resources");
    }

    #[test]
    fn supervised_stdin_eof_allows_graceful_exit() {
        let marker = test_marker("graceful");
        let script = r#"
const fs = require('node:fs');
const marker = process.argv[1];
process.stdin.resume();
process.stdin.once('end', () => {
  fs.writeFileSync(marker, 'graceful');
  process.exit(0);
});
process.stdout.write('ready\n');
"#;
        let mut process = spawn_node_fixture(script, &marker, Duration::from_secs(2));
        assert!(!process.shutdown(None).expect("fixture shuts down"));
        assert_eq!(
            fs::read_to_string(&marker).expect("graceful marker"),
            "graceful"
        );
        fs::remove_file(marker).expect("remove graceful marker");
    }

    #[test]
    fn framed_shutdown_allows_graceful_exit() {
        let marker = test_marker("framed-graceful");
        let script = r#"
const fs = require('node:fs');
const marker = process.argv[1];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  const boundary = input.indexOf('\n');
  if (boundary === -1) return;
  const line = input.slice(0, boundary);
  const frame = JSON.parse(line.slice('DSH-IPC/1 '.length));
  if (frame.kind === 'shutdown') {
    fs.writeFileSync(marker, 'framed');
    process.exit(0);
  }
});
process.stdout.write('ready\n');
"#;
        let mut process = spawn_node_fixture(script, &marker, Duration::from_secs(2));
        let bridge = SidecarBridge::new();
        bridge.install_writer(
            process
                .child
                .inner()
                .stdin
                .take()
                .expect("Node fixture stdin is piped"),
        );
        assert!(!process
            .shutdown(Some(&bridge))
            .expect("fixture shuts down through a frame"));
        assert_eq!(
            fs::read_to_string(&marker).expect("framed marker"),
            "framed"
        );
        fs::remove_file(marker).expect("remove framed marker");
    }

    #[test]
    fn shutdown_escalation_terminates_descendants() {
        let marker = test_marker("descendant");
        let script = r#"
const { spawn } = require('node:child_process');
const marker = process.argv[1];
const descendant = `
  const fs = require('node:fs');
  const marker = process.argv[1];
  setTimeout(() => fs.writeFileSync(marker, 'escaped'), 500);
  setInterval(() => {}, 60_000);
`;
spawn(process.execPath, ['-e', descendant, marker], { stdio: 'ignore' });
process.stdin.resume();
process.stdin.once('end', () => {});
process.stdout.write('ready\n');
setInterval(() => {}, 60_000);
"#;
        let mut process = spawn_node_fixture(script, &marker, Duration::from_millis(50));
        assert!(process
            .shutdown(None)
            .expect("fixture process tree shuts down"));
        thread::sleep(Duration::from_millis(700));
        assert!(
            !marker.exists(),
            "descendant survived the process-tree termination"
        );
    }
}
