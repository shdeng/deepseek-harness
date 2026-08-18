use std::{
    collections::{HashMap, VecDeque},
    io::Write,
    process::ChildStdin,
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Url};
use tokio::sync::oneshot;

pub const PROTOCOL_PREFIX: &str = "DSH-IPC/1 ";
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const MAX_ACTIVE_REQUESTS: usize = 256;
const MAX_CANCELLED_REQUESTS: usize = 512;

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
pub enum DesktopRequest {
    AssetRead {
        id: String,
        asset: String,
    },
    GameAssetRead {
        id: String,
        asset: String,
        path: String,
    },
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
            Self::AssetRead { id, .. }
            | Self::GameAssetRead { id, .. }
            | Self::Fetch { id, .. }
            | Self::StreamOpen { id, .. } => id,
        }
    }

    fn validate(&self) -> Result<(), String> {
        validate_id(self.id())?;
        match self {
            Self::AssetRead { asset, .. } => {
                validate_asset_digest(asset)?;
            }
            Self::GameAssetRead { asset, path, .. } => {
                validate_asset_digest(asset)?;
                validate_game_asset_path(path)?;
            }
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
                if path == "/api/credentials.set" {
                    return Err("desktop IPC does not carry plaintext credential writes".to_owned());
                }
                if path == "/api/llm.discoverModels" {
                    let payload = body.as_deref().ok_or_else(|| {
                        "desktop IPC model discovery has no request body".to_owned()
                    })?;
                    let envelope: Value = serde_json::from_str(payload).map_err(|_| {
                        "desktop IPC model discovery request body is not JSON".to_owned()
                    })?;
                    if envelope.pointer("/payload/apiKey").is_some() {
                        return Err(
                            "desktop IPC model discovery accepts credential handles only"
                                .to_owned(),
                        );
                    }
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
    Ready(Value),
    NativeRequest(NativeRequest),
    Handled,
}

#[derive(Debug)]
pub enum NativeRequest {
    PickDirectory {
        id: String,
    },
    CaptureCredential {
        id: String,
        credential: String,
    },
    OpenExternal {
        id: String,
        url: String,
    },
    Notify {
        id: String,
        title: String,
        body: String,
    },
    MediaCompanion {
        id: String,
        url: Url,
        active: bool,
    },
    GameCompanion {
        id: String,
        url: Url,
        title: String,
        mode: GameCompanionMode,
        active_agent_count: u32,
        reason: Option<GameAttentionReason>,
    },
    Metadata {
        id: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GameCompanionMode {
    Hidden,
    Playable,
    Attention,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GameAttentionReason {
    WorkComplete,
    Approval,
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
            "ready" => {
                let manifest = frame
                    .get("manifest")
                    .cloned()
                    .ok_or_else(|| "Node Host desktop ready frame has no manifest".to_owned())?;
                validate_boot_manifest(&manifest)?;
                Ok(ProtocolLine::Ready(manifest))
            }
            "shutdown-complete" => {
                frame_id(&frame)?;
                Ok(ProtocolLine::Handled)
            }
            "native-request" => {
                let id = frame_id(&frame)?.to_owned();
                let request = frame
                    .get("request")
                    .and_then(Value::as_object)
                    .ok_or_else(|| "Node Host native request must carry an object".to_owned())?;
                match request.get("op").and_then(Value::as_str) {
                    Some("pick-directory") => {
                        if request.len() != 1 {
                            return Err(
                                "Node Host directory request carries unsupported fields".to_owned()
                            );
                        }
                        Ok(ProtocolLine::NativeRequest(NativeRequest::PickDirectory {
                            id,
                        }))
                    }
                    Some("capture-credential") => {
                        if request.len() != 2 {
                            return Err("Node Host credential request carries unsupported fields"
                                .to_owned());
                        }
                        let credential = request
                            .get("credential")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                "Node Host credential request has no handle".to_owned()
                            })?;
                        validate_credential_handle(credential)?;
                        Ok(ProtocolLine::NativeRequest(
                            NativeRequest::CaptureCredential {
                                id,
                                credential: credential.to_owned(),
                            },
                        ))
                    }
                    Some("open-external") => {
                        if request.len() != 2 {
                            return Err(
                                "Node Host external-link request carries unsupported fields"
                                    .to_owned(),
                            );
                        }
                        let url = request.get("url").and_then(Value::as_str).ok_or_else(|| {
                            "Node Host external-link request has no URL".to_owned()
                        })?;
                        if url.len() > 4096 {
                            return Err("Node Host external-link URL exceeds 4096 bytes".to_owned());
                        }
                        Ok(ProtocolLine::NativeRequest(NativeRequest::OpenExternal {
                            id,
                            url: url.to_owned(),
                        }))
                    }
                    Some("notify") => {
                        if request.len() != 3 {
                            return Err(
                                "Node Host notification request carries unsupported fields"
                                    .to_owned(),
                            );
                        }
                        let title =
                            request
                                .get("title")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    "Node Host notification request has no title".to_owned()
                                })?;
                        let body =
                            request.get("body").and_then(Value::as_str).ok_or_else(|| {
                                "Node Host notification request has no body".to_owned()
                            })?;
                        if title.is_empty() || title.len() > 128 || body.len() > 1024 {
                            return Err(
                                "Node Host notification text is outside its bounds".to_owned()
                            );
                        }
                        Ok(ProtocolLine::NativeRequest(NativeRequest::Notify {
                            id,
                            title: title.to_owned(),
                            body: body.to_owned(),
                        }))
                    }
                    Some("media-companion") => {
                        if request.len() != 3 {
                            return Err(
                                "Node Host media companion request carries unsupported fields"
                                    .to_owned(),
                            );
                        }
                        let url = request.get("url").and_then(Value::as_str).ok_or_else(|| {
                            "Node Host media companion request has no URL".to_owned()
                        })?;
                        let active =
                            request
                                .get("active")
                                .and_then(Value::as_bool)
                                .ok_or_else(|| {
                                    "Node Host media companion request has no boolean active state"
                                        .to_owned()
                                })?;
                        Ok(ProtocolLine::NativeRequest(NativeRequest::MediaCompanion {
                            id,
                            url: validate_media_url(url)?,
                            active,
                        }))
                    }
                    Some("game-companion") => {
                        if !matches!(request.len(), 5 | 6) {
                            return Err(
                                "Node Host game companion request carries unsupported fields"
                                    .to_owned(),
                            );
                        }
                        let url = request.get("url").and_then(Value::as_str).ok_or_else(|| {
                            "Node Host game companion request has no URL".to_owned()
                        })?;
                        let title =
                            request
                                .get("title")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    "Node Host game companion request has no title".to_owned()
                                })?;
                        if title.is_empty() || title.len() > 80 || title.trim() != title {
                            return Err(
                                "Node Host game companion title is outside its bounds".to_owned()
                            );
                        }
                        let mode = match request.get("mode").and_then(Value::as_str) {
                            Some("hidden") => GameCompanionMode::Hidden,
                            Some("playable") => GameCompanionMode::Playable,
                            Some("attention") => GameCompanionMode::Attention,
                            _ => {
                                return Err("Node Host game companion request has an invalid mode"
                                    .to_owned())
                            }
                        };
                        let active_agent_count = request
                            .get("activeAgentCount")
                            .and_then(Value::as_u64)
                            .and_then(|value| u32::try_from(value).ok())
                            .filter(|value| *value <= 1024)
                            .ok_or_else(|| {
                                "Node Host game companion request has an invalid active Agent count"
                                    .to_owned()
                            })?;
                        let reason = match request.get("reason").and_then(Value::as_str) {
                            Some("work-complete") => Some(GameAttentionReason::WorkComplete),
                            Some("approval") => Some(GameAttentionReason::Approval),
                            Some(_) => return Err(
                                "Node Host game companion request has an invalid attention reason"
                                    .to_owned(),
                            ),
                            None => None,
                        };
                        if (mode == GameCompanionMode::Attention) != reason.is_some() {
                            return Err("Node Host game companion attention mode and reason must appear together".to_owned());
                        }
                        Ok(ProtocolLine::NativeRequest(NativeRequest::GameCompanion {
                            id,
                            url: validate_game_url(url)?,
                            title: title.to_owned(),
                            mode,
                            active_agent_count,
                            reason,
                        }))
                    }
                    Some("metadata") => {
                        if request.len() != 1 {
                            return Err(
                                "Node Host metadata request carries unsupported fields".to_owned()
                            );
                        }
                        Ok(ProtocolLine::NativeRequest(NativeRequest::Metadata { id }))
                    }
                    other => Err(format!(
                        "Node Host requested unsupported native operation {other:?}"
                    )),
                }
            }
            "native-cancel" => {
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

    pub fn send_native_response(
        &self,
        id: &str,
        result: Result<Value, String>,
    ) -> Result<(), String> {
        validate_id(id)?;
        match result {
            Ok(value) => self.send(json!({
                "v": 1,
                "kind": "native-response",
                "id": id,
                "result": value,
            })),
            Err(error) => self.send(json!({
                "v": 1,
                "kind": "native-response",
                "id": id,
                "error": error,
            })),
        }
    }

    /// Send one validated unsolicited native event to the Node Host.
    pub fn send_deep_link(&self, session_id: &str) -> Result<(), String> {
        if session_id.is_empty() || session_id.len() > 256 {
            return Err("desktop deep-link session id is outside its bounds".to_owned());
        }
        self.send(json!({
            "v": 1,
            "kind": "native-event",
            "event": "deep-link",
            "sessionId": session_id,
        }))
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

fn validate_boot_manifest(manifest: &Value) -> Result<(), String> {
    let object = manifest
        .as_object()
        .ok_or_else(|| "Node Host desktop manifest must be an object".to_owned())?;
    if !object.get("rev").is_some_and(Value::is_string) {
        return Err("Node Host desktop manifest rev must be a string".to_owned());
    }
    let entries = object
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| "Node Host desktop manifest entries must be an array".to_owned())?;
    if entries.len() > 4096 {
        return Err("Node Host desktop manifest has too many entries".to_owned());
    }
    for entry in entries {
        let row = entry
            .as_object()
            .ok_or_else(|| "Node Host desktop manifest entry must be an object".to_owned())?;
        let url = row
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| "Node Host desktop manifest entry has no URL".to_owned())?;
        let url = Url::parse(url)
            .map_err(|_| "Node Host desktop manifest entry has an invalid URL".to_owned())?;
        if url.scheme() != "dsh-plugin"
            || url.host_str() != Some("localhost")
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("Node Host desktop manifest entry uses an unauthorized URL".to_owned());
        }
        let Some(asset) = url
            .path()
            .strip_prefix('/')
            .and_then(|path| path.strip_suffix("/client.js"))
        else {
            return Err("Node Host desktop manifest entry has an invalid asset path".to_owned());
        };
        validate_asset_digest(asset)?;
        let mut query = url.query_pairs();
        if !query
            .next()
            .is_some_and(|(key, value)| key == "rev" && !value.is_empty())
            || query.next().is_some()
        {
            return Err(
                "Node Host desktop manifest entry has an invalid revision query".to_owned(),
            );
        }
    }
    Ok(())
}

/// Return a validated manifest using the custom-protocol URL form understood by the target WebView.
pub(crate) fn webview_boot_manifest(
    mut manifest: Value,
    http_custom_protocol: bool,
) -> Result<Value, String> {
    validate_boot_manifest(&manifest)?;
    if !http_custom_protocol {
        return Ok(manifest);
    }
    let entries = manifest["entries"]
        .as_array_mut()
        .expect("validated desktop manifest entries are an array");
    for entry in entries {
        let url = entry["url"]
            .as_str()
            .expect("validated desktop manifest entry URL is a string");
        entry["url"] = Value::String(url.replacen(
            "dsh-plugin://localhost/",
            "http://dsh-plugin.localhost/",
            1,
        ));
    }
    Ok(manifest)
}

pub(crate) fn validate_asset_digest(asset: &str) -> Result<(), String> {
    if asset.len() != 64
        || !asset
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("desktop IPC asset id must be a 64-character lowercase hex digest".to_owned());
    }
    Ok(())
}

pub(crate) fn validate_game_asset_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains("..")
        || path.contains("//")
        || !path.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-/".contains(&byte)
        })
        || !path.as_bytes()[0].is_ascii_alphanumeric()
    {
        return Err(
            "desktop IPC game asset path must be normalized lowercase relative text".to_owned(),
        );
    }
    Ok(())
}

pub(crate) fn validate_game_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "game companion URL is not absolute".to_owned())?;
    if url.scheme() != "dsh-game"
        || url.host_str() != Some("localhost")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("game companion URL must use the local dsh-game authority".to_owned());
    }
    let mut segments = url
        .path_segments()
        .ok_or_else(|| "game companion URL has no asset path".to_owned())?;
    let digest = segments.next().unwrap_or_default();
    let entry = segments.next().unwrap_or_default();
    if segments.next().is_some() || entry != "index.html" {
        return Err("game companion URL must select one content-addressed index.html".to_owned());
    }
    validate_asset_digest(digest)?;
    Ok(url)
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

fn validate_credential_handle(handle: &str) -> Result<(), String> {
    let mut bytes = handle.bytes();
    let Some(first) = bytes.next() else {
        return Err("desktop credential handle is empty".to_owned());
    };
    if !(first.is_ascii_alphabetic() || first == b'_')
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err("desktop credential handle must be a POSIX identifier".to_owned());
    }
    Ok(())
}

/** Validate the only remote top-level navigation the native media window accepts. */
pub fn validate_media_url(value: &str) -> Result<Url, String> {
    if value.is_empty() || value.len() > 4096 {
        return Err("desktop media companion URL is outside its bounds".to_owned());
    }
    let url =
        Url::parse(value).map_err(|_| "desktop media companion URL is not absolute".to_owned())?;
    let host = url
        .host_str()
        .ok_or_else(|| "desktop media companion URL has no host".to_owned())?
        .to_ascii_lowercase();
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || !(host == "bilibili.com" || host.ends_with(".bilibili.com") || host == "b23.tv")
    {
        return Err(
            "desktop media companion allows credential-free Bilibili HTTPS URLs only".to_owned(),
        );
    }
    Ok(url)
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
    fn rejects_plaintext_credentials_before_the_node_pipe() {
        let credential_write = DesktopRequest::Fetch {
            id: "credential-write".to_owned(),
            path: "/api/credentials.set".to_owned(),
            method: "POST".to_owned(),
            headers: HashMap::new(),
            body: Some("{\"payload\":{\"ref\":\"KEY\",\"value\":\"secret\"}}".to_owned()),
        };
        assert!(credential_write
            .validate()
            .unwrap_err()
            .contains("plaintext credential"));

        let discovery = DesktopRequest::Fetch {
            id: "credential-discovery".to_owned(),
            path: "/api/llm.discoverModels".to_owned(),
            method: "POST".to_owned(),
            headers: HashMap::new(),
            body: Some("{\"payload\":{\"settingsNs\":\"llm\",\"apiKey\":\"secret\"}}".to_owned()),
        };
        assert!(discovery.validate().unwrap_err().contains("handles only"));
    }

    #[test]
    fn media_urls_are_bounded_to_credential_free_bilibili_https() {
        assert!(validate_media_url("https://www.bilibili.com/video/BV1x").is_ok());
        assert!(validate_media_url("https://space.bilibili.com/1").is_ok());
        assert!(validate_media_url("https://b23.tv/example").is_ok());
        assert!(validate_media_url("http://www.bilibili.com/video/BV1x").is_err());
        assert!(validate_media_url("https://user:secret@www.bilibili.com/video/BV1x").is_err());
        assert!(validate_media_url("https://example.com/video/BV1x").is_err());
    }

    #[test]
    fn game_urls_and_asset_paths_are_content_addressed_local_text() {
        let digest = "a".repeat(64);
        assert!(validate_game_url(&format!("dsh-game://localhost/{digest}/index.html")).is_ok());
        assert!(validate_game_url(&format!("https://localhost/{digest}/index.html")).is_err());
        assert!(validate_game_url(&format!("dsh-game://localhost/{digest}/other.html")).is_err());
        assert!(validate_game_asset_path("game.js").is_ok());
        assert!(validate_game_asset_path("nested/game.css").is_ok());
        assert!(validate_game_asset_path("../secret").is_err());
        assert!(validate_game_asset_path("Game.js").is_err());
    }

    #[test]
    fn accepts_bounded_url_safe_request_ids() {
        assert!(validate_id("8d18b3e2-3d60-4db2_a").is_ok());
        assert!(validate_id("").is_err());
        assert!(validate_id("not/a/request").is_err());
    }

    #[test]
    fn validates_desktop_boot_manifest_asset_urls() {
        let digest = "a".repeat(64);
        assert!(validate_boot_manifest(&json!({
            "rev": "revision-1",
            "entries": [{ "url": format!("dsh-plugin://localhost/{digest}/client.js?rev=revision-1") }]
        }))
        .is_ok());
        assert!(validate_boot_manifest(&json!({
            "rev": "revision-1",
            "entries": [{ "url": format!("dsh-plugin://example.com/{digest}/client.js?rev=revision-1") }]
        }))
        .unwrap_err()
        .contains("unauthorized"));
        assert!(validate_boot_manifest(&json!({
            "rev": "revision-1",
            "entries": [{ "url": "dsh-plugin://localhost/not-a-digest/client.js?rev=revision-1" }]
        }))
        .unwrap_err()
        .contains("digest"));
    }

    #[test]
    fn maps_custom_protocol_urls_for_webview2() {
        let digest = "a".repeat(64);
        let manifest = json!({
            "rev": "revision-1",
            "entries": [{ "url": format!("dsh-plugin://localhost/{digest}/client.js?rev=revision-1") }]
        });

        let mapped = webview_boot_manifest(manifest.clone(), true).expect("valid manifest maps");
        assert_eq!(
            mapped["entries"][0]["url"],
            format!("http://dsh-plugin.localhost/{digest}/client.js?rev=revision-1")
        );
        assert_eq!(
            webview_boot_manifest(manifest.clone(), false)
                .expect("valid manifest remains canonical"),
            manifest
        );
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
