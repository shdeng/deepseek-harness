use std::time::Duration;

use reqwest::Url;
use semver::Version;
use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/shdeng/deepseek-harness-app/releases/latest";
const RELEASE_PAGE_PREFIX: &str = "/shdeng/deepseek-harness-app/releases/tag/";
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RELEASE_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

#[derive(Debug, PartialEq)]
struct UpdateCandidate {
    tag: String,
    version: Version,
    release_url: Url,
}

fn parse_release_version(tag: &str) -> Result<Version, String> {
    let value = tag.strip_prefix('v').unwrap_or(tag);
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.is_empty()
        || parts.len() > 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(format!(
            "release tag {tag:?} is not a stable numeric version"
        ));
    }
    let normalized = match parts.len() {
        1 => format!("{value}.0.0"),
        2 => format!("{value}.0"),
        3 => value.to_owned(),
        _ => unreachable!("the part count was validated"),
    };
    Version::parse(&normalized).map_err(|error| format!("invalid release tag {tag:?}: {error}"))
}

fn available_update(
    release: GitHubRelease,
    current: &Version,
) -> Result<Option<UpdateCandidate>, String> {
    if release.draft || release.prerelease {
        return Ok(None);
    }
    let version = parse_release_version(&release.tag_name)?;
    if version <= *current {
        return Ok(None);
    }
    let release_url = Url::parse(&release.html_url)
        .map_err(|error| format!("release URL is invalid: {error}"))?;
    let expected_path = format!("{RELEASE_PAGE_PREFIX}{}", release.tag_name);
    if release_url.scheme() != "https"
        || release_url.host_str() != Some("github.com")
        || release_url.port().is_some()
        || !release_url.username().is_empty()
        || release_url.password().is_some()
        || release_url.path() != expected_path
        || release_url.query().is_some()
        || release_url.fragment().is_some()
    {
        return Err(format!(
            "release URL is outside the trusted repository: {}",
            release_url
        ));
    }
    Ok(Some(UpdateCandidate {
        tag: release.tag_name,
        version,
        release_url,
    }))
}

async fn fetch_available_update() -> Result<Option<UpdateCandidate>, String> {
    let current = Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|error| format!("desktop version is invalid: {error}"))?;
    let client = reqwest::Client::builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .build()
        .map_err(|error| format!("failed to create the update client: {error}"))?;
    let mut response = client
        .get(LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header(
            "User-Agent",
            format!("deepseek-harness-desktop/{}", env!("CARGO_PKG_VERSION")),
        )
        .send()
        .await
        .map_err(|error| format!("GitHub release request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("GitHub release request failed: {error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RELEASE_RESPONSE_BYTES as u64)
    {
        return Err("GitHub release response exceeds 64 KiB".to_owned());
    }
    let mut body = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(MAX_RELEASE_RESPONSE_BYTES as u64) as usize,
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("GitHub release response is invalid: {error}"))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_RELEASE_RESPONSE_BYTES {
            return Err("GitHub release response exceeds 64 KiB".to_owned());
        }
        body.extend_from_slice(&chunk);
    }
    let release = serde_json::from_slice::<GitHubRelease>(&body)
        .map_err(|error| format!("GitHub release response is invalid: {error}"))?;
    available_update(release, &current)
}

fn update_prompt(candidate: &UpdateCandidate) -> String {
    format!(
        "DeepSeek Harness Desktop {} is available. You are using v{}. Open the GitHub release page to download and install it?\n\nYour configuration and session history under $DSH_HOME are not changed by the update.",
        candidate.tag,
        env!("CARGO_PKG_VERSION")
    )
}

pub(crate) fn start_update_check(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        match fetch_available_update().await {
            Ok(Some(candidate)) => {
                let release_url = candidate.release_url.to_string();
                app.dialog()
                    .message(update_prompt(&candidate))
                    .title("DeepSeek Harness update")
                    .kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Open release page".to_owned(),
                        "Later".to_owned(),
                    ))
                    .show(move |confirmed| {
                        if confirmed {
                            if let Err(error) = crate::open_external(&release_url) {
                                eprintln!("[dsh-desktop] failed to open the release page: {error}");
                            }
                        }
                    });
            }
            Ok(None) => {}
            Err(error) => eprintln!("[dsh-desktop] update check failed: {error}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag.to_owned(),
            html_url: format!("https://github.com/shdeng/deepseek-harness-app/releases/tag/{tag}"),
            draft: false,
            prerelease: false,
        }
    }

    #[test]
    fn accepts_a_newer_stable_release_with_a_short_tag() {
        let candidate = available_update(release("v0.2"), &Version::new(0, 1, 0))
            .expect("release is valid")
            .expect("release is newer");
        assert_eq!(candidate.tag, "v0.2");
        assert_eq!(candidate.version, Version::new(0, 2, 0));
    }

    #[test]
    fn ignores_equal_older_draft_and_prerelease_versions() {
        let current = Version::new(1, 2, 3);
        assert_eq!(available_update(release("v1.2.3"), &current), Ok(None));
        assert_eq!(available_update(release("v1.2.2"), &current), Ok(None));
        let mut draft = release("v2.0");
        draft.draft = true;
        assert_eq!(available_update(draft, &current), Ok(None));
        let mut prerelease = release("v2.0");
        prerelease.prerelease = true;
        assert_eq!(available_update(prerelease, &current), Ok(None));
    }

    #[test]
    fn rejects_non_numeric_tags_and_untrusted_release_urls() {
        assert!(available_update(release("nightly"), &Version::new(0, 1, 0)).is_err());
        let mut untrusted = release("v0.2");
        untrusted.html_url = "https://example.com/download".to_owned();
        assert!(available_update(untrusted, &Version::new(0, 1, 0)).is_err());
    }

    #[test]
    fn update_prompt_names_the_versions_and_data_guarantee() {
        let current = Version::parse(env!("CARGO_PKG_VERSION")).expect("package version is valid");
        let candidate = available_update(release("v0.5"), &current)
            .expect("release is valid")
            .expect("release is newer");
        assert_eq!(
            update_prompt(&candidate),
            format!(
                "DeepSeek Harness Desktop v0.5 is available. You are using v{}. Open the GitHub release page to download and install it?\n\nYour configuration and session history under $DSH_HOME are not changed by the update.",
                env!("CARGO_PKG_VERSION")
            )
        );
    }
}
