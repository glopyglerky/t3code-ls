use super::{OwnedChild, POLL_INTERVAL, STARTUP_TIMEOUT, browser::Browser, pairing_link, sample};
use crate::Result;
use serde_json::{Value, json};
use std::{
    env,
    ffi::OsString,
    fs::{self, File},
    io::Write,
    net::TcpListener,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const THREADS: usize = 32;
const MESSAGES: usize = 200;
const SELECTED_THREAD: &str = "import:codex:0251af00-0000-4000-8000-000000000000";

/// Seed and reopen one saved workspace using the same browser and server profile.
/// All fixture creation, import, cache writes and the first shutdown precede the timer.
pub fn run(args: impl Iterator<Item = OsString>) -> Result<()> {
    if !cfg!(target_os = "linux") {
        return Err("the mature-workspace probe currently requires Linux".into());
    }
    let args: Vec<_> = args.collect();
    let [node, bundle, trial, driver, chrome, mode] = args.as_slice() else {
        return Err("usage: t3code-ls-tools probe-reopen NODE BUNDLE NEW_TRIAL_DIRECTORY CHROMEDRIVER CHROME stock|native|fork-sqlite".into());
    };
    let implementation = match mode.to_str() {
        Some("stock") => None,
        Some("native") => Some("native"),
        Some("fork-sqlite") => Some("upstream"),
        _ => return Err("reopen implementation must be stock, native or fork-sqlite".into()),
    };
    let node = fs::canonicalize(node)?;
    let bundle = fs::canonicalize(bundle)?;
    let trial = Path::new(trial);
    fs::create_dir(trial)?;
    let trial = fs::canonicalize(trial)?;
    let base = trial.join("profile");
    let state = base.join("userdata");
    let workspace = trial.join("reopen-fixture");
    let codex_home = trial.join(".codex");
    fs::create_dir_all(&state)?;
    fs::create_dir(&workspace)?;
    fs::write(workspace.join("notes.txt"), "Synthetic saved workspace.\n")?;
    let mut providers = serde_json::Map::new();
    for driver in [
        "claudeAgent",
        "pi",
        "cursor",
        "grok",
        "fx",
        "opencode",
        "antigravity",
        "kiro",
        "muse",
    ] {
        providers.insert(driver.into(), json!({"driver": driver, "enabled": false}));
    }
    providers.insert("codex".into(), json!({
        "driver": "codex", "enabled": true,
        "config": {"setupMode": "existing", "homePath": codex_home, "binaryPath": trial.join("absent-codex")},
    }));
    fs::write(
        state.join("settings.json"),
        serde_json::to_vec(&json!({"providerInstances": providers}))?,
    )?;
    let reservation = TcpListener::bind(("127.0.0.1", 0))?;
    let port = reservation.local_addr()?.port();
    drop(reservation);
    let origin = format!("http://127.0.0.1:{port}");
    let make_server = || -> Result<Command> {
        let mut command = Command::new(&node);
        command
            .arg(&bundle)
            .args(["serve", "--host", "127.0.0.1", "--port"])
            .arg(port.to_string())
            .arg("--base-dir")
            .arg(&base)
            .current_dir(&trial)
            .env_clear()
            .env("PATH", env::var_os("PATH").ok_or("missing PATH")?)
            .env("HOME", &trial)
            .env("CODEX_HOME", &codex_home)
            .env("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD", "false")
            .env("T3CODE_TELEMETRY_ENABLED", "false")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(implementation) = implementation {
            command.env("T3_CODE_LS_IMPLEMENTATION", implementation);
        }
        Ok(command)
    };
    let browser = Browser::start(Path::new(driver), Path::new(chrome), &trial)?;
    let initial_start = Instant::now();
    let mut initial = OwnedChild(make_server()?.spawn()?);
    let pairing = pairing_link(initial.0.stdout.take().ok_or("missing pairing pipe")?);
    let (initial_origin, _, _, _) = sample(&mut initial.0, &state, initial_start)?;
    if initial_origin != origin {
        return Err("fixture server bound an unexpected origin".into());
    }
    let link = pairing.recv_timeout(STARTUP_TIMEOUT.saturating_sub(initial_start.elapsed()))?;
    if !link.starts_with(&format!("{origin}/pair#token=")) {
        return Err("pairing link escaped the fixture origin".into());
    }
    browser.attach(&link, initial_start, false)?;
    let fixture_bytes = write_transcripts(&codex_home, &workspace)?;
    let (route, before) = browser.seed_reopen(&workspace, SELECTED_THREAD, THREADS, MESSAGES)?;
    stop_gracefully(&mut initial)?;
    let native = implementation == Some("native");
    if state.join("statev2.omdb").is_file() != native
        || state.join("statev2.sqlite").is_file() == native
    {
        return Err("seeded workspace used an unexpected database".into());
    }

    let started = Instant::now();
    let mut reopened = OwnedChild(make_server()?.spawn()?);
    let _pairing_output = pairing_link(reopened.0.stdout.take().ok_or("missing reopen output")?);
    let (reopened_origin, descriptor_micros, html_micros, migration) =
        sample(&mut reopened.0, &state, started)?;
    if reopened_origin != origin {
        return Err("reopened server changed the fixture origin".into());
    }
    let navigation_started_micros = started.elapsed().as_micros();
    let result = browser.reopen(&origin, &route, SELECTED_THREAD, THREADS, MESSAGES)?;
    if before["messages"] != result["snapshot"]["messages"]
        || before["threadSequence"] != result["snapshot"]["threadSequence"]
    {
        let after = &result["snapshot"];
        let first_differing_message = before["messages"]
            .as_array()
            .zip(after["messages"].as_array())
            .and_then(|(before, after)| before.iter().zip(after).position(|(a, b)| a != b));
        return Err(format!(
            "reopened {mode} history differs: cursor {} -> {}, messages {} -> {}, first differing index {first_differing_message:?}",
            before["threadSequence"], after["threadSequence"], before["messageCount"], after["messageCount"],
            mode = implementation.unwrap_or("stock"),
        ).into());
    }
    let mut snapshot = result["snapshot"].clone();
    snapshot
        .as_object_mut()
        .ok_or("missing reopen snapshot")?
        .remove("messages");
    browser.close()?;
    stop_gracefully(&mut reopened)?;
    println!(
        "{}",
        json!({
            "schema_version": 1, "journey": "J02", "profile": mode.to_str(),
            "fixture": {"threads": THREADS, "messages_per_thread": MESSAGES, "total_messages": THREADS * MESSAGES, "transcript_bytes": fixture_bytes},
            "descriptor_micros": descriptor_micros, "html_micros": html_micros,
            "navigation_started_micros": navigation_started_micros, "database_migration": migration,
            "browser": result["timing"], "snapshot": snapshot,
            "cache": "same authenticated browser profile with observed persisted shell and selected-thread records",
            "filesystem_cache": "unmanaged, after fixture import and clean stop",
            "cpu_rss_qualified": false, "cached_paint_attribution_qualified": false,
        })
    );
    Ok(())
}

fn write_transcripts(codex_home: &Path, workspace: &Path) -> Result<u64> {
    let directory = codex_home.join("sessions/2026/11/01");
    fs::create_dir_all(&directory)?;
    let mut total = 0;
    for thread in 0..THREADS {
        let id = format!("0251af00-0000-4000-8000-{thread:012}");
        let mut file =
            File::create_new(directory.join(format!("rollout-2026-11-01T00-00-00-{id}.jsonl")))?;
        writeln!(
            file,
            "{}",
            json!({"type": "session_meta", "payload": {"id": id, "cwd": workspace}})
        )?;
        for index in 0..MESSAGES {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            let text = format!(
                "Reopen fixture {thread:04} {role} {index:04}\n{}",
                "Synthetic saved history. ".repeat(8).trim()
            );
            let timestamp = format!("2026-11-01T00:{:02}:{:02}.000Z", index / 60, index % 60);
            let record: Value = if role == "user" {
                json!({"timestamp": timestamp, "type": "event_msg", "payload": {"type": "user_message", "message": text}})
            } else {
                json!({"timestamp": timestamp, "type": "response_item", "payload": {"type": "message", "role": role, "content": [{"type": "output_text", "text": text}]}})
            };
            writeln!(file, "{record}")?;
        }
        total += file.metadata()?.len();
    }
    Ok(total)
}

fn stop_gracefully(child: &mut OwnedChild) -> Result<()> {
    if child.0.try_wait()?.is_some() {
        return Err("fixture server exited before its requested shutdown".into());
    }
    let status = Command::new("/bin/kill")
        .args(["-TERM", &child.0.id().to_string()])
        .status()?;
    if !status.success() {
        return Err("could not terminate the owned fixture server".into());
    }
    let started = Instant::now();
    while child.0.try_wait()?.is_none() {
        if started.elapsed() > Duration::from_secs(10) {
            child.stop()?;
            return Err("fixture server did not stop cleanly within 10 seconds".into());
        }
        thread::sleep(POLL_INTERVAL);
    }
    Ok(())
}
