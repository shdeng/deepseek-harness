#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::VecDeque,
    env,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    thread,
    time::{Duration, Instant},
};

use command_group::{CommandGroup, GroupChild};
use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

const HOST_URL_PREFIX: &str = "dsh web: ";
const STDERR_TAIL_LINES: usize = 40;
const DEFAULT_HOST_SHUTDOWN_GRACE_MS: u64 = 7_000;
const MAX_HOST_SHUTDOWN_GRACE_MS: u64 = 60_000;
const HOST_SHUTDOWN_GRACE_ENV: &str = "DSH_DESKTOP_SHUTDOWN_GRACE_MS";
const SUPERVISED_STDIN_ENV: &str = "DSH_SHUTDOWN_ON_STDIN_EOF";

#[derive(Debug)]
struct HostLaunch {
    node: PathBuf,
    cli: PathBuf,
    cwd: PathBuf,
    shutdown_grace: Duration,
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
        Ok(Self {
            node,
            cli,
            cwd,
            shutdown_grace,
        })
    }

    fn spawn(&self) -> Result<HostProcess, String> {
        let mut command = Command::new(&self.node);
        command
            .arg(&self.cli)
            .args(["web", "--host", "127.0.0.1", "--port", "0"])
            .current_dir(&self.cwd)
            .env(SUPERVISED_STDIN_ENV, "1")
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

    fn shutdown(&mut self) -> Result<bool, String> {
        drop(self.child.inner().stdin.take());
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
    allowed_port: RwLock<Option<u16>>,
}

impl NavigationFence {
    fn publish(&self, port: u16) {
        *self
            .allowed_port
            .write()
            .expect("navigation port lock poisoned") = Some(port);
    }

    fn allows(&self, url: &Url) -> bool {
        if url.scheme() == "tauri" {
            return true;
        }
        if matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost") {
            return true;
        }
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port()
                == *self
                    .allowed_port
                    .read()
                    .expect("navigation port lock poisoned")
    }
}

#[derive(Debug)]
struct HostState {
    child: Mutex<Option<HostProcess>>,
    ready: AtomicBool,
    shutting_down: AtomicBool,
    stderr_tail: Mutex<VecDeque<String>>,
    navigation: Arc<NavigationFence>,
}

impl HostState {
    fn new(navigation: Arc<NavigationFence>) -> Self {
        Self {
            child: Mutex::new(None),
            ready: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            stderr_tail: Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)),
            navigation,
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
        *self.child.lock().expect("Host child lock poisoned") = Some(child);

        let stdout_state = Arc::clone(self);
        let stdout_app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        println!("[dsh-host] {line}");
                        if let Some(result) = parse_host_url(&line) {
                            match result {
                                Ok(url) => stdout_state.publish_host_url(&stdout_app, url),
                                Err(error) => report_status(&stdout_app, &error),
                            }
                        }
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

    fn publish_host_url(&self, app: &tauri::AppHandle, url: Url) {
        if self.ready.swap(true, Ordering::AcqRel) {
            return;
        }
        let port = url.port().expect("validated Host URL has a port");
        self.navigation.publish(port);
        let Some(window) = app.get_webview_window("main") else {
            report_status(
                app,
                "desktop window disappeared before the Node Host became ready",
            );
            return;
        };
        if let Err(error) = window.navigate(url) {
            report_status(
                app,
                &format!("failed to navigate to the Node Host: {error}"),
            );
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
        match child.shutdown() {
            Ok(true) => eprintln!(
                "[dsh-desktop] Node Host did not quiesce within {} ms; terminated its process tree",
                child.shutdown_grace.as_millis()
            ),
            Ok(false) => {}
            Err(error) => eprintln!("[dsh-desktop] {error}"),
        }
    }
}

fn absolute_path(path: PathBuf, base: &Path) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn parse_host_url(line: &str) -> Option<Result<Url, String>> {
    let value = line.strip_prefix(HOST_URL_PREFIX)?;
    Some(
        Url::parse(value)
            .map_err(|error| format!("Node Host published an invalid URL: {error}"))
            .and_then(|url| {
                if url.scheme() != "http"
                    || url.host_str() != Some("127.0.0.1")
                    || url.port().is_none()
                {
                    return Err(format!(
                        "Node Host published a URL outside the desktop loopback policy: {url}"
                    ));
                }
                Ok(url)
            }),
    )
}

fn report_status(app: &tauri::AppHandle, message: &str) {
    eprintln!("[dsh-desktop] {message}");
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let encoded = serde_json::to_string(message).expect("status string serializes as JSON");
    let _ = window.eval(format!("window.__DSH_DESKTOP_SET_STATUS__?.({encoded})"));
}

#[tauri::command]
fn desktop_pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
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

fn create_window(
    app: &tauri::AppHandle,
    navigation: Arc<NavigationFence>,
) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("DeepSeek Harness Desktop")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 640.0)
        .on_navigation(move |url| navigation.allows(url))
        .build()
}

fn main() {
    let navigation = Arc::new(NavigationFence::default());
    let host = Arc::new(HostState::new(Arc::clone(&navigation)));
    let setup_host = Arc::clone(&host);
    let setup_navigation = Arc::clone(&navigation);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::clone(&host))
        .invoke_handler(tauri::generate_handler![desktop_pick_directory])
        .setup(move |app| {
            create_window(app.handle(), Arc::clone(&setup_navigation))?;
            if let Err(error) = setup_host.start(app.handle().clone()) {
                report_status(app.handle(), &error);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri desktop shell");

    app.run(move |_app, event| {
        if matches!(event, RunEvent::ExitRequested { .. }) {
            host.shutdown();
        }
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
    fn parses_loopback_host_url() {
        let url = parse_host_url("dsh web: http://127.0.0.1:4123/")
            .expect("matching log line")
            .expect("valid URL");
        assert_eq!(url.port(), Some(4123));
    }

    #[test]
    fn rejects_host_url_without_explicit_port() {
        let error = parse_host_url("dsh web: http://127.0.0.1/")
            .expect("matching log line")
            .expect_err("port is required");
        assert!(error.contains("loopback policy"));
    }

    #[test]
    fn rejects_non_loopback_host_url() {
        let error = parse_host_url("dsh web: http://localhost:4123/")
            .expect("matching log line")
            .expect_err("literal loopback address is required");
        assert!(error.contains("loopback policy"));
    }

    #[test]
    fn navigation_fence_allows_only_published_host_port() {
        let fence = NavigationFence::default();
        fence.publish(4123);
        assert!(fence.allows(&Url::parse("http://127.0.0.1:4123/").unwrap()));
        assert!(!fence.allows(&Url::parse("http://127.0.0.1:4124/").unwrap()));
        assert!(!fence.allows(&Url::parse("https://example.com/").unwrap()));
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
        assert!(!process.shutdown().expect("fixture shuts down"));
        assert_eq!(
            fs::read_to_string(&marker).expect("graceful marker"),
            "graceful"
        );
        fs::remove_file(marker).expect("remove graceful marker");
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
        assert!(process.shutdown().expect("fixture process tree shuts down"));
        thread::sleep(Duration::from_millis(700));
        assert!(
            !marker.exists(),
            "descendant survived the process-tree termination"
        );
    }
}
