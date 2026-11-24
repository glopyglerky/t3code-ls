use crate::Result;
use serde_json::{Map, Value, json};
use std::io::{self, Read, Write};

const RELEASES: &str = "https://github.com/pingdotgg/t3code/releases";
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const TARGETS: [&str; 7] = [
    "arm64.dmg",
    "x64.dmg",
    "x64.exe",
    "amd64.deb",
    "x86_64.AppImage",
    "arm64.deb",
    "arm64.AppImage",
];

fn route_part(value: &str) -> bool {
    value.len() <= 200
        && value.starts_with(|c: char| c.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b'+'))
}

fn release_catalog(release: &Value, nightly: bool) -> Option<Value> {
    let tag = release["tag_name"].as_str()?;
    if !route_part(tag)
        || tag.contains("-nightly.") != nightly
        || release["draft"] == true
        || (!nightly && release["prerelease"] == true)
    {
        return None;
    }
    let mut downloads = Map::new();
    for asset in release["assets"].as_array()? {
        let Some(name) = asset["name"].as_str().filter(|name| route_part(name)) else {
            continue;
        };
        let Some(target) = TARGETS.iter().find(|target| {
            name.strip_suffix(**target)
                .is_some_and(|prefix| prefix.ends_with('-'))
        }) else {
            continue;
        };
        let expected = format!("{RELEASES}/download/{tag}/{name}");
        if asset["browser_download_url"].as_str() == Some(expected.as_str()) {
            downloads.entry(*target).or_insert(Value::String(expected));
        }
    }
    Some(json!({
        "tag": tag,
        "release": format!("{RELEASES}/tag/{tag}"),
        "downloads": downloads,
    }))
}

fn catalog(snapshot: &Value) -> Value {
    let nightly = snapshot["nightlies"].as_array().and_then(|releases| {
        releases
            .iter()
            .find_map(|release| release_catalog(release, true))
    });
    json!({
        "stable": release_catalog(&snapshot["stable"], false),
        "nightly": nightly,
    })
}

pub fn run() -> Result<()> {
    let mut input = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut input)?;
    if input.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("Release catalog input exceeds 1 MiB".into());
    }
    let snapshot: Value = serde_json::from_slice(&input)?;
    if !snapshot.is_object() {
        return Err("Release catalog input must be an object".into());
    }
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &catalog(&snapshot))?;
    writeln!(stdout)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_assets_match_channel_architecture_and_the_release_path() {
        let stable = json!({
            "tag_name": "v42.0.0",
            "assets": [
                {"name": "bundle-arm64.dmg", "browser_download_url": "https://fixture.invalid/wrong"},
                {"name": "bundle-x64.dmg", "browser_download_url": format!("{RELEASES}/download/v42.0.0/bundle-x64.dmg")},
                {"name": "wrong-arm64.dmg", "browser_download_url": format!("{RELEASES}/download/v0.1.0/wrong-arm64.dmg")},
                {"name": "bundle-arm64.dmg", "browser_download_url": format!("{RELEASES}/download/v42.0.0/bundle-arm64.dmg")},
                {"name": "bundle-arm64.dmg.sha256", "browser_download_url": format!("{RELEASES}/download/v42.0.0/bundle-arm64.dmg.sha256")}
            ]
        });
        let mut nightly = stable.clone();
        nightly["tag_name"] = json!("v43.0.0-nightly.1");
        nightly["assets"] = json!([{
            "name": "nightly-amd64.deb",
            "browser_download_url": format!("{RELEASES}/download/v43.0.0-nightly.1/nightly-amd64.deb"),
        }]);
        let result = catalog(&json!({"stable": stable, "nightlies": [null, stable, nightly]}));
        assert_eq!(result["stable"]["downloads"].as_object().unwrap().len(), 2);
        assert_eq!(
            result["stable"]["downloads"]["arm64.dmg"],
            format!("{RELEASES}/download/v42.0.0/bundle-arm64.dmg"),
        );
        assert_eq!(result["nightly"]["tag"], "v43.0.0-nightly.1");
        assert_eq!(result["nightly"]["downloads"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn unavailable_or_invalid_releases_leave_the_site_fallback() {
        assert_eq!(
            catalog(&json!({"stable": {"tag_name": "../unsafe", "assets": []}})),
            json!({"stable": null, "nightly": null})
        );
        assert_eq!(
            catalog(&json!({"stable": {"tag_name": "v42", "draft": true, "assets": []}})),
            json!({"stable": null, "nightly": null})
        );
    }
}
