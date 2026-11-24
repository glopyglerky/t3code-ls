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
        [node, bundle, trial, driver, chrome, replay, mode, trace @ ..]
            if conversation && (trace.len() <= 1 || (trace.len() == 2 && trace[1] == "server-spans")) => (
            node, bundle, trial, Some((driver, chrome)),
            match mode.to_str() {
                Some("stock" | "stock-j06" | "stock-j06-attribution") => None,
                Some("native-j06-combined-reads" | "native-j06-receipt-reads" | "native-j06-attribution" | "native-j06" | "native-j06-turn-start-batch" | "native-j06-turn-start-batch-attribution" | "native-j06-independent-reads-attribution" | "native" | "native-single-reads" | "native-independent-reads" | "native-independent-lookups") => Some("native"),
                Some("fork-sqlite" | "fork-sqlite-j06-attribution") => Some("upstream"),
                _ => return Err("unknown conversation profile".into()),
            },
            Some(fs::canonicalize(replay)?),
            trace.first().map(|wrapper| {
                Ok::<_, std::io::Error>((fs::canonicalize(wrapper)?, trace.len() == 2))
            }).transpose()?,
        ),
        _ if conversation => return Err("usage: t3code-ls-tools probe-conversation NODE BUNDLE NEW_TRIAL_DIRECTORY CHROMEDRIVER CHROME STOCK_REPLAY_AGENT stock|stock-j06|native-j06|native-j06-turn-start-batch|native-j06-receipt-reads|native-j06-combined-reads|stock-j06-attribution|native-j06-attribution|native-j06-turn-start-batch-attribution|native-j06-independent-reads-attribution|native|native-single-reads|native-independent-reads|native-independent-lookups|fork-sqlite|fork-sqlite-j06-attribution [TRACE_WRAPPER [server-spans]]".into()),
        _ => return Err("usage: t3code-ls-tools probe-startup NODE BUNDLE NEW_TRIAL_DIRECTORY [CHROMEDRIVER CHROME [fork-sqlite]]".into()),
    };
    let node = fs::canonicalize(node)?;
    let profile = args
        .get(6)
        .and_then(|mode| mode.to_str())
        .filter(|_| conversation);
    let attribution = matches!(
        profile,
        Some("stock-j06-attribution" | "native-j06-attribution" | "native-j06-turn-start-batch-attribution" | "native-j06-independent-reads-attribution" | "fork-sqlite-j06-attribution")
    );
    if attribution && !trace.as_ref().is_some_and(|(_, spans)| *spans) {
        return Err("J06 attribution requires the shared trace wrapper and server-spans".into());
    }
    let combined_reads = profile == Some("native-j06-combined-reads");
    let batch_turn_start = combined_reads || matches!(profile, Some("native-j06-turn-start-batch" | "native-j06-turn-start-batch-attribution"));
    let single_receipt_reads = combined_reads || profile == Some("native-j06-receipt-reads");
    let scoped_j06 =
        attribution || batch_turn_start || single_receipt_reads || matches!(profile, Some("stock-j06" | "native-j06"));
    let single_projection_reads = combined_reads || matches!(
        profile,
        Some("native-single-reads" | "native-independent-lookups")
    );
    let independent_reads = matches!(
        profile,
        Some("native-independent-reads" | "native-independent-lookups" | "native-j06-independent-reads-attribution")
    );
    let bundle = fs::canonicalize(bundle)?;
    let trial = Path::new(trial);
    fs::create_dir(trial)?;
    let trial = fs::canonicalize(trial)?;
    let base = trial.join("profile");
    let state = base.join("userdata");
    let workspace = trial.join("conversation-fixture");
    let trace_log = trial.join("provider-trace.ndjson");
    let server_trace = trial.join("server-trace.ndjson");
    let record_server_spans = trace.as_ref().is_some_and(|(_, spans)| *spans);
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
                                Some((wrapper, _)) => vec![wrapper, replay, &trace_log],
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
    if single_projection_reads {
        command.env("T3_CODE_LS_SINGLE_PROJECTION_READS", "1");
    }
    if independent_reads {
        command.env("T3_CODE_LS_INDEPENDENT_READS", "1");
    }
    if single_receipt_reads {
        command.env("T3_CODE_LS_SINGLE_RECEIPT_READS", "1");
    }
    if batch_turn_start {
        command.env("T3_CODE_LS_BATCH_TURN_START_CONTEXT", "1");
    }
    if record_server_spans {
        command
            .env("T3CODE_TRACE_MIN_LEVEL", "Trace")
            .env("T3CODE_TRACE_BATCH_WINDOW_MS", "100")
            .env("T3CODE_TRACE_FILE", &server_trace);
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
                    result["conversation"] =
                        browser.conversation(&workspace, scoped_j06, attribution)?;
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
    let server_spans = if record_server_spans {
        let start = browser
            .as_ref()
            .and_then(|proof| proof["conversation"]["timing"]["submitEpochMillis"].as_f64())
            .ok_or("missing browser submit timestamp")?;
        let end = if attribution {
            start
                + browser
                    .as_ref()
                    .and_then(|proof| proof["conversation"]["timing"]["terminalMillis"].as_f64())
                    .ok_or("missing terminal timestamp")?
        } else {
            provider_trace
                .as_ref()
                .and_then(|entries| entries.iter().find(|entry| entry["phase"] == "prompt"))
                .and_then(|entry| entry["millis"].as_f64())
                .ok_or("missing provider prompt timestamp")?
        };
        Some(read_server_spans(&server_trace, start, end, attribution)?)
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
            "scoped_j06": scoped_j06,
            "attribution": attribution,
            "accept_observer": if scoped_j06 { "browser-websocket-launch-ack-upper-bound" } else { "none" },
            "single_projection_reads": single_projection_reads,
            "single_receipt_reads": single_receipt_reads,
            "independent_reads": independent_reads,
            "batch_turn_start_context": batch_turn_start,
            "poll_interval_micros": POLL_INTERVAL.as_micros(),
            "descriptor_micros": descriptor_micros,
            "html_micros": html_micros,
            "database_migration": database_migration,
            "browser": browser,
            "provider_trace": provider_trace,
            "server_spans": server_spans,
        })
    );
    Ok(())
}

fn read_server_spans(
    path: &Path,
    submit: f64,
    prompt: f64,
    attribution: bool,
) -> Result<Vec<Value>> {
    let trace = fs::File::open(path)?;
    if trace.metadata()?.len() > 10 * 1024 * 1024 || prompt <= submit {
        return Err("invalid server trace size or phase boundaries".into());
    }
    let mut spans = Vec::new();
    for line in BufReader::new(trace).lines() {
        let line = line?;
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let start = record["startTimeUnixNano"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok());
        let end = record["endTimeUnixNano"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok());
        let (Some(start), Some(end), Some(name)) = (start, end, record["name"].as_str()) else {
            continue;
        };
        let start = start / 1_000_000.0;
        let end = end / 1_000_000.0;
        if (if attribution {
            end < submit || start > prompt
        } else {
            start < submit || end > prompt
        }) || end < start
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        {
            continue;
        }
        spans.push(json!({ "name": name, "start_ms": start - submit, "duration_ms": end - start, "end_ms": end - submit }));
    }
    if spans.is_empty() {
        return Err("no closed server spans between submit and prompt".into());
    }
    Ok(spans)
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
