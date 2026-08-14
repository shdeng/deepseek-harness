#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::VecDeque,
    env,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    thread,
    time::Duration,
};

use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

const HOST_URL_PREFIX: &str = "dsh web: ";
const STDERR_TAIL_LINES: usize = 40;

#[derive(Debug)]
struct HostLaunch {
    node: PathBuf,
    cli: PathBuf,
    cwd: PathBuf,
}

impl HostLaunch {
    fn resolve() -> Result<Self, String> {
        let cwd = env::var_os("DSH_DESKTOP_CWD")
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(env::current_dir)
            .map_err(|error| format!("failed to resolve the Host working directory: {error}"))?;
        let node = env::var_os("DSH_DESKTOP_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node"));
        let default_cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../cli/lib/bin.js");
        let cli = absolute_path(
            env::var_os("DSH_DESKTOP_CLI")
                .map(PathBuf::from)
                .unwrap_or(default_cli),
            &cwd,
        );

        if !cli.is_file() {
            return Err(format!(
                "built CLI not found at {}. Run `pnpm run build` or set DSH_DESKTOP_CLI",
                cli.display()
            ));
        }

        Ok(Self { node, cli, cwd })
    }

    fn spawn(&self) -> Result<Child, String> {
        let mut command = Command::new(&self.node);
        command
            .arg(&self.cli)
            .args(["web", "--host", "127.0.0.1", "--port", "0"])
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        command.spawn().map_err(|error| {
            format!(
                "failed to start Node Host with {}: {error}",
                self.node.display()
            )
        })
    }
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
    child: Mutex<Option<Child>>,
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
        let launch = HostLaunch::resolve()?;
        let mut child = launch.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Node Host stdout pipe was not created".to_owned())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Node Host stderr pipe was not created".to_owned())?;
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
                match child.try_wait() {
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
                let tail = self
                    .stderr_tail
                    .lock()
                    .expect("Host stderr lock poisoned")
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");
                let detail = if tail.is_empty() {
                    String::new()
                } else {
                    format!("\n\nRecent Host errors:\n{tail}")
                };
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
        if child.try_wait().ok().flatten().is_none() {
            if let Err(error) = child.kill() {
                eprintln!("failed to stop Node Host: {error}");
            }
        }
        if let Err(error) = child.wait() {
            eprintln!("failed to reap Node Host: {error}");
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
}
