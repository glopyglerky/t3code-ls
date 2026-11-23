mod browser;

use crate::Result;
use serde_json::{Value, json};
use std::{
    env,
    ffi::OsString,
    fs,
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const POLL_INTERVAL: Duration = Duration::from_millis(10);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

pub fn run(args: impl Iterator<Item = OsString>, conversation: bool) -> Result<()> {
    let args: Vec<_> = args.collect();
    let (node, bundle, trial, browsers, implementation, replay, trace) = match args.as_slice() {
        [node, bundle, trial] if !conversation => (node, bundle, trial, None, None, None, None),
        [node, bundle, trial, driver, chrome] if !conversation => {
            (node, bundle, trial, Some((driver, chrome)), None, None, None)
        }
        [node, bundle, trial, driver, chrome, mode] if !conversation && mode == "fork-sqlite" => {
            (node, bundle, trial, Some((driver, chrome)), Some("upstream"), None, None)
        }
        [node, bundle, trial, driver, chrome, replay, mode, trace @ ..] if conversation && trace.len() <= 1 => (
            node, bundle, trial, Some((driver, chrome)),
            match mode.to_str() {
                Some("stock") => None,
                Some("native") => Some("native"),
                Some("fork-sqlite") => Some("upstream"),
                _ => return Err("conversation implementation must be stock, native or fork-sqlite".into()),
            },
            Some(fs::canonicalize(replay)?),
            trace.first().map(fs::canonicalize).transpose()?,
        ),
        _ if conversation => return Err("usage: t3code-ls-tools probe-conversation NODE BUNDLE NEW_TRIAL_DIRECTORY CHROMEDRIVER CHROME STOCK_REPLAY_AGENT stock|native|fork-sqlite [TRACE_WRAPPER]".into()),
        _ => return Err("usage: t3code-ls-tools probe-startup NODE BUNDLE NEW_TRIAL_DIRECTORY [CHROMEDRIVER CHROME [fork-sqlite]]".into()),
    };
    let node = fs::canonicalize(node)?;
    let bundle = fs::canonicalize(bundle)?;
    let trial = Path::new(trial);
    fs::create_dir(trial)?;
    let trial = fs::canonicalize(trial)?;
    let base = trial.join("profile");
    let state = base.join("userdata");
    let workspace = trial.join("conversation-fixture");
    let trace_log = trial.join("provider-trace.ndjson");
    if let Some(replay) = &replay {
        fs::create_dir_all(&state)?;
        fs::create_dir(&workspace)?;
        fs::write(
            workspace.join("notes.txt"),
            "Disposable conversation measurement.\n",
        )?;
        fs::write(
            state.join("settings.json"),
            serde_json::to_vec(&json!({
                "responseStreamingMode": "paragraph",
                "providerInstances": {
                    "devReplay": {
                        "displayName": "Replay (dev)",
                        "driver": "acpRegistry",
                        "config": {
                            "source": "local",
                            "commandPath": node,
                            "commandArgs": match &trace {
                                Some(trace) => vec![trace, replay, &trace_log],
                                None => vec![replay],
                            },
                        }
                    }
                }
            }))?,
        )?;
    }
    let browser = browsers
        .map(|(driver, chrome)| {
            browser::Browser::start(Path::new(driver), Path::new(chrome), &trial)
        })
        .transpose()?;
    let mut command = Command::new(node);
    command
        .arg(bundle)
        .args(["serve", "--host", "127.0.0.1", "--base-dir"])
        .arg(base)
        .current_dir(&trial)
        .env_clear()
        .env("PATH", env::var_os("PATH").ok_or("missing PATH")?)
        .env("HOME", &trial)
        .env("T3CODE_TELEMETRY_ENABLED", "false")
        .stdin(Stdio::null())
        .stdout(if browser.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::null());
    if let Some(implementation) = implementation {
        command.env("T3_CODE_LS_IMPLEMENTATION", implementation);
    }

    let start = Instant::now();
    let mut child = OwnedChild(command.spawn()?);
    let pairing = child.0.stdout.take().map(pairing_link);
    let (origin, descriptor_micros, html_micros, database_migration) =
        sample(&mut child.0, &state, start)?;
    let native = implementation == Some("native");
    if state.join("statev2.sqlite").is_file() == native
        || state.join("statev2.omdb").is_file() != native
    {
        return Err("fresh profile did not use the expected database".into());
    }
    let browser = if let Some(browser) = browser {
        let pairing = pairing.ok_or("missing server pairing output pipe")?;
        let link = pairing.recv_timeout(STARTUP_TIMEOUT.saturating_sub(start.elapsed()))?;
        let prefix = format!("{origin}/pair#token=");
        if !link
            .strip_prefix(&prefix)
            .is_some_and(|token| !token.is_empty())
        {
            return Err("pairing link does not target the owned loopback application".into());
        }
        let result = browser
            .attach(&link, start, conversation)
            .and_then(|mut result| {
                if conversation {
                    result["conversation"] = browser.conversation(&workspace)?;
                }
                Ok(result)
            });
        let closed = browser.close();
        let result = result?;
        closed?;
        Some(result)
    } else {
        None
    };
    child.stop()?;
    let provider_trace = if trace.is_some() {
        let entries = fs::read_to_string(trace_log)?
            .lines()
            .map(serde_json::from_str::<Value>)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for phase in ["prompt", "first_chunk", "prompt_result"] {
            if entries
                .iter()
                .filter(|entry| entry["phase"] == phase)
                .count()
                != 1
            {
                return Err(format!("expected one {phase} in the provider trace").into());
            }
        }
        Some(entries)
    } else {
        None
    };
    let profile = match (implementation, browser.is_some()) {
        (Some("native"), _) => "new-native-linux-browser-profile",
        (Some("upstream"), _) => "new-fork-linux-browser-profile",
        (_, true) => "new-stock-linux-browser-profile",
        (_, false) => "new-stock-linux-server-home",
    };
    println!(
        "{}",
        json!({
            "schema_version": 1,
            "profile": profile,
            "poll_interval_micros": POLL_INTERVAL.as_micros(),
            "descriptor_micros": descriptor_micros,
            "html_micros": html_micros,
            "database_migration": database_migration,
            "browser": browser,
            "provider_trace": provider_trace,
        })
    );
    Ok(())
}

struct OwnedChild(Child);

impl OwnedChild {
    fn stop(&mut self) -> Result<()> {
        if self.0.try_wait()?.is_none() {
            self.0.kill()?;
        }
        self.0.wait()?;
        Ok(())
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn pairing_link(stdout: std::process::ChildStdout) -> mpsc::Receiver<String> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout)
            .lines()
            .map_while(std::result::Result::ok)
        {
            if let Some(link) = line.strip_prefix("Pairing URL: ") {
                let _ = sender.send(link.trim().to_owned());
            }
        }
    });
    receiver
}

fn sample(child: &mut Child, state: &Path, start: Instant) -> Result<(String, u128, u128, u64)> {
    let runtime_path = state.join("server-runtime.json");
    let (origin, descriptor, descriptor_micros) = loop {
        if let Some(status) = child.try_wait()? {
            return Err(format!("bundled application exited before readiness: {status}").into());
        }
        if start.elapsed() >= STARTUP_TIMEOUT {
            return Err(
                "bundled application did not serve its environment descriptor within 30 seconds"
                    .into(),
            );
        }
        if let Some(origin) = runtime_origin(&runtime_path, child.id())?
            && let Some(response) = fetch(&origin, "/.well-known/t3/environment")?
        {
            break (origin, response, start.elapsed().as_micros());
        }
        thread::sleep(POLL_INTERVAL);
    };
    let descriptor: Value = serde_json::from_slice(&descriptor)?;
    let environment_id = fs::read_to_string(state.join("environment-id"))?;
    if environment_id.trim().is_empty()
        || descriptor["environmentId"].as_str() != Some(environment_id.trim())
    {
        return Err("served environment identity disagrees with the fresh profile".into());
    }
    let migration = descriptor["databaseMigration"]
        .as_u64()
        .filter(|version| *version > 0)
        .ok_or("served descriptor did not identify an applied database migration")?;
    let html = fetch(&origin, "/")?.ok_or("application did not serve its built web entry")?;
    let html_micros = start.elapsed().as_micros();
    if !std::str::from_utf8(&html)?.contains("id=\"root\"") {
        return Err("web entry did not contain the application root".into());
    }
    Ok((origin, descriptor_micros, html_micros, migration))
}

fn runtime_origin(path: &Path, pid: u32) -> Result<Option<String>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let runtime: Value = serde_json::from_slice(&bytes)?;
    let port = runtime["port"]
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
        .ok_or("runtime record has no bound port")?;
    let origin = format!("http://127.0.0.1:{port}");
    if runtime["pid"].as_u64() != Some(u64::from(pid))
        || runtime["origin"].as_str() != Some(origin.as_str())
    {
        return Err("runtime record does not identify the owned loopback application".into());
    }
    Ok(Some(origin))
}

fn fetch(origin: &str, path: &str) -> Result<Option<Vec<u8>>> {
    let response = Command::new("curl")
        .args([
            "-q",
            "--noproxy",
            "*",
            "--silent",
            "--max-time",
            "1",
            "--write-out",
            "\n%{response_code}",
        ])
        .arg(format!("{origin}{path}"))
        .output()?;
    match response.status.code() {
        Some(0) => {}
        Some(7 | 28) => return Ok(None),
        _ => return Err(format!("curl failed for {path}: {}", response.status).into()),
    }
    let mut parts = response.stdout.rsplitn(2, |byte| *byte == b'\n');
    let status = parts.next().ok_or("curl returned no response status")?;
    let body = parts
        .next()
        .ok_or("curl returned no response body separator")?;
    match status {
        b"200" => Ok(Some(body.to_vec())),
        b"503" => Ok(None),
        _ => Err(format!(
            "unexpected HTTP {} for {path}",
            std::str::from_utf8(status)?
        )
        .into()),
    }
}
