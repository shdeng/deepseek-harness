use std::{
    collections::{HashMap, VecDeque},
    io::Write,
    process::ChildStdin,
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

pub const PROTOCOL_PREFIX: &str = "DSH-IPC/1 ";
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const MAX_ACTIVE_REQUESTS: usize = 256;
const MAX_CANCELLED_REQUESTS: usize = 512;

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
pub enum DesktopRequest {
    Fetch {
        id: String,
        path: String,
        method: String,
        headers: HashMap<String, String>,
        body: Option<String>,
    },
    StreamOpen {
        id: String,
        stream: StreamName,
        payload: Value,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamName {
    Mux,
    Host,
}

impl DesktopRequest {
    pub fn id(&self) -> &str {
        match self {
            Self::Fetch { id, .. } | Self::StreamOpen { id, .. } => id,
        }
    }

    fn validate(&self) -> Result<(), String> {
        validate_id(self.id())?;
        match self {
            Self::Fetch {
                path, method, body, ..
            } => {
                if !path.starts_with('/') || path.starts_with("//") {
                    return Err("desktop IPC fetch path must be an absolute local path".to_owned());
                }
                if !matches!(method.as_str(), "GET" | "HEAD" | "POST") {
                    return Err("desktop IPC fetch method must be GET, HEAD, or POST".to_owned());
                }
                if matches!(method.as_str(), "GET" | "HEAD") && body.is_some() {
                    return Err("desktop IPC GET and HEAD requests cannot carry a body".to_owned());
                }
            }
            Self::StreamOpen { payload, .. } if !payload.is_object() => {
                return Err("desktop IPC stream payload must be an object".to_owned());
            }
            Self::StreamOpen { .. } => {}
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Clone)]
struct StreamEvent {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<Value>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    end: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub enum ProtocolLine {
    NotProtocol,
    Ready,
    Handled,
}

#[derive(Debug)]
pub struct SidecarBridge {
    writer: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    streams: Mutex<HashMap<String, String>>,
    cancelled: Mutex<VecDeque<String>>,
}

impl SidecarBridge {
    pub fn new() -> Self {
        Self {
            writer: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(VecDeque::new()),
        }
    }

    pub fn install_writer(&self, writer: ChildStdin) {
        *self.writer.lock().expect("sidecar writer lock poisoned") = Some(writer);
    }

    pub async fn request(
        &self,
        request: DesktopRequest,
        window_label: String,
    ) -> Result<Value, String> {
        request.validate()?;
        let id = request.id().to_owned();
        if self.take_cancelled(&id) {
            return Err("desktop IPC request was cancelled before dispatch".to_owned());
        }
        let stream = matches!(request, DesktopRequest::StreamOpen { .. });
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().expect("sidecar pending lock poisoned");
            if pending.len() >= MAX_ACTIVE_REQUESTS {
                return Err("desktop IPC has too many active requests".to_owned());
            }
            if pending.insert(id.clone(), sender).is_some() {
                return Err(format!("desktop IPC request id {id:?} is already active"));
            }
        }
        if stream {
            self.streams
                .lock()
                .expect("sidecar streams lock poisoned")
                .insert(id.clone(), window_label);
        }
        if let Err(error) = self.send(json!({ "v": 1, "kind": "request", "request": request })) {
            self.pending
                .lock()
                .expect("sidecar pending lock poisoned")
                .remove(&id);
            self.streams
                .lock()
                .expect("sidecar streams lock poisoned")
                .remove(&id);
            return Err(error);
        }
        receiver
            .await
            .map_err(|_| format!("Node Host ended desktop IPC request {id:?} without a response"))?
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        self.send(json!({ "v": 1, "kind": "cancel", "id": id }))?;
        if let Some(sender) = self
            .pending
            .lock()
            .expect("sidecar pending lock poisoned")
            .remove(id)
        {
            let _ = sender.send(Err("desktop IPC request was cancelled".to_owned()));
        }
        self.streams
            .lock()
            .expect("sidecar streams lock poisoned")
            .remove(id);
        self.mark_cancelled(id);
        Ok(())
    }

    pub fn cancel_window(&self, label: &str) -> Result<(), String> {
        let ids = self
            .streams
            .lock()
            .expect("sidecar streams lock poisoned")
            .iter()
            .filter_map(|(id, owner)| (owner == label).then_some(id.clone()))
            .collect::<Vec<_>>();
        for id in ids {
            self.cancel(&id)?;
        }
        Ok(())
    }

    pub fn request_shutdown(&self) -> Result<(), String> {
        self.send(json!({ "v": 1, "kind": "shutdown", "id": "desktop-shutdown" }))
    }

    pub fn close_writer(&self) {
        self.writer
            .lock()
            .expect("sidecar writer lock poisoned")
            .take();
    }

    pub fn handle_line(&self, app: &AppHandle, line: &str) -> Result<ProtocolLine, String> {
        let Some(payload) = line.strip_prefix(PROTOCOL_PREFIX) else {
            return Ok(ProtocolLine::NotProtocol);
        };
        if line.len() > MAX_FRAME_BYTES {
            return Err(format!(
                "Node Host desktop IPC frame exceeds {MAX_FRAME_BYTES} bytes"
            ));
        }
        let frame: Value = serde_json::from_str(payload)
            .map_err(|error| format!("Node Host desktop IPC frame is not JSON: {error}"))?;
        if frame.get("v") != Some(&Value::from(1)) {
            return Err("Node Host desktop IPC frame has an unsupported version".to_owned());
        }
        let kind = frame
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| "Node Host desktop IPC frame has no kind".to_owned())?;
        match kind {
            "ready" => Ok(ProtocolLine::Ready),
            "shutdown-complete" => {
                frame_id(&frame)?;
                Ok(ProtocolLine::Handled)
            }
            "response" => {
                let id = frame_id(&frame)?;
                let sender = self
                    .pending
                    .lock()
                    .expect("sidecar pending lock poisoned")
                    .remove(id);
                let Some(sender) = sender else {
                    if self.take_cancelled(id) {
                        return Ok(ProtocolLine::Handled);
                    }
                    return Err(format!(
                        "Node Host answered unknown desktop IPC request {id:?}"
                    ));
                };
                let result = match frame.get("error").and_then(Value::as_str) {
                    Some(error) => Err(error.to_owned()),
                    None => frame
                        .get("result")
                        .cloned()
                        .ok_or_else(|| "Node Host desktop IPC response has no result".to_owned()),
                };
                if result.is_err() {
                    self.streams
                        .lock()
                        .expect("sidecar streams lock poisoned")
                        .remove(id);
                }
                let _ = sender.send(result);
                Ok(ProtocolLine::Handled)
            }
            "stream-frame" => {
                let id = frame_id(&frame)?;
                if self.is_cancelled(id) {
                    return Ok(ProtocolLine::Handled);
                }
                let message = frame
                    .get("message")
                    .cloned()
                    .ok_or_else(|| "Node Host desktop stream frame has no message".to_owned())?;
                self.emit_stream(app, id, Some(message), false, None)?;
                Ok(ProtocolLine::Handled)
            }
            "stream-end" => {
                let id = frame_id(&frame)?;
                if self.take_cancelled(id) {
                    return Ok(ProtocolLine::Handled);
                }
                let error = frame
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.emit_stream(app, id, None, true, error)?;
                self.streams
                    .lock()
                    .expect("sidecar streams lock poisoned")
                    .remove(id);
                Ok(ProtocolLine::Handled)
            }
            "fatal" => {
                let message = frame
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Node Host reported an unspecified desktop IPC failure");
                self.fail_all(message);
                Err(message.to_owned())
            }
            other => Err(format!(
                "Node Host sent unsupported desktop IPC frame kind {other:?}"
            )),
        }
    }

    pub fn fail_all(&self, message: &str) {
        let pending =
            std::mem::take(&mut *self.pending.lock().expect("sidecar pending lock poisoned"));
        for sender in pending.into_values() {
            let _ = sender.send(Err(message.to_owned()));
        }
        self.streams
            .lock()
            .expect("sidecar streams lock poisoned")
            .clear();
    }

    fn send(&self, frame: Value) -> Result<(), String> {
        let encoded = serde_json::to_string(&frame)
            .map_err(|error| format!("failed to encode desktop IPC frame: {error}"))?;
        if encoded.len() + PROTOCOL_PREFIX.len() > MAX_FRAME_BYTES {
            return Err(format!("desktop IPC frame exceeds {MAX_FRAME_BYTES} bytes"));
        }
        let mut writer = self.writer.lock().expect("sidecar writer lock poisoned");
        let writer = writer
            .as_mut()
            .ok_or_else(|| "Node Host desktop IPC pipe is not available".to_owned())?;
        writer
            .write_all(format!("{PROTOCOL_PREFIX}{encoded}\n").as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("failed to write Node Host desktop IPC frame: {error}"))
    }

    fn emit_stream(
        &self,
        app: &AppHandle,
        id: &str,
        message: Option<Value>,
        end: bool,
        error: Option<String>,
    ) -> Result<(), String> {
        let label = self
            .streams
            .lock()
            .expect("sidecar streams lock poisoned")
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Node Host sent a frame for unknown desktop stream {id:?}"))?;
        app.emit_to(
            label,
            "dsh-ipc-stream",
            StreamEvent {
                id: id.to_owned(),
                message,
                end,
                error,
            },
        )
        .map_err(|error| format!("failed to emit desktop stream frame: {error}"))
    }

    fn mark_cancelled(&self, id: &str) {
        let mut cancelled = self
            .cancelled
            .lock()
            .expect("sidecar cancelled lock poisoned");
        if cancelled.len() == MAX_CANCELLED_REQUESTS {
            cancelled.pop_front();
        }
        cancelled.push_back(id.to_owned());
    }

    fn is_cancelled(&self, id: &str) -> bool {
        self.cancelled
            .lock()
            .expect("sidecar cancelled lock poisoned")
            .iter()
            .any(|candidate| candidate == id)
    }

    fn take_cancelled(&self, id: &str) -> bool {
        let mut cancelled = self
            .cancelled
            .lock()
            .expect("sidecar cancelled lock poisoned");
        let Some(index) = cancelled.iter().position(|candidate| candidate == id) else {
            return false;
        };
        cancelled.remove(index);
        true
    }
}

fn frame_id(frame: &Value) -> Result<&str, String> {
    let id = frame
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Node Host desktop IPC frame has no request id".to_owned())?;
    validate_id(id)?;
    Ok(id)
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~-".contains(&byte))
    {
        return Err("desktop IPC request id must be 1-128 URL-safe ASCII characters".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn rejects_non_local_fetch_targets() {
        let request = DesktopRequest::Fetch {
            id: "request-1".to_owned(),
            path: "//example.com/api/session.list".to_owned(),
            method: "POST".to_owned(),
            headers: HashMap::new(),
            body: Some("{}".to_owned()),
        };
        assert!(request.validate().unwrap_err().contains("local path"));
    }

    #[test]
    fn accepts_bounded_url_safe_request_ids() {
        assert!(validate_id("8d18b3e2-3d60-4db2_a").is_ok());
        assert!(validate_id("").is_err());
        assert!(validate_id("not/a/request").is_err());
    }

    #[test]
    fn cancelled_request_tombstones_are_consumed_by_late_terminals() {
        let bridge = SidecarBridge::new();
        bridge.mark_cancelled("late-request");
        assert!(bridge.is_cancelled("late-request"));
        assert!(bridge.take_cancelled("late-request"));
        assert!(!bridge.is_cancelled("late-request"));
    }

    #[test]
    fn host_failure_rejects_pending_calls_and_drops_stream_routes() {
        let bridge = SidecarBridge::new();
        let (sender, receiver) = oneshot::channel();
        bridge
            .pending
            .lock()
            .expect("sidecar pending lock")
            .insert("pending-request".to_owned(), sender);
        bridge
            .streams
            .lock()
            .expect("sidecar streams lock")
            .insert("stream-1".to_owned(), "main".to_owned());
        bridge.fail_all("Host crashed");
        assert_eq!(
            receiver.blocking_recv().expect("pending call is resolved"),
            Err("Host crashed".to_owned())
        );
        assert!(bridge
            .streams
            .lock()
            .expect("sidecar streams lock")
            .is_empty());
    }

    #[test]
    fn closing_one_window_cancels_only_its_streams() {
        let mut child = Command::new("node")
            .args(["-e", "process.stdin.resume()"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("Node stdin fixture starts");
        let bridge = SidecarBridge::new();
        bridge.install_writer(child.stdin.take().expect("Node stdin is piped"));
        {
            let mut streams = bridge.streams.lock().expect("sidecar streams lock");
            streams.insert("main-stream".to_owned(), "main".to_owned());
            streams.insert("other-stream".to_owned(), "other".to_owned());
        }
        bridge.cancel_window("main").expect("window streams cancel");
        assert_eq!(
            *bridge.streams.lock().expect("sidecar streams lock"),
            HashMap::from([("other-stream".to_owned(), "other".to_owned())])
        );
        child.kill().expect("Node stdin fixture terminates");
        bridge.close_writer();
        child.wait().expect("Node stdin fixture is reaped");
    }
}
