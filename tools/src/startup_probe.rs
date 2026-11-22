use crate::Result;
use serde_json::{Value, json};
use std::{
    env,
    ffi::OsString,
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const POLL_INTERVAL: Duration = Duration::from_millis(10);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

pub fn run(args: impl Iterator<Item = OsString>) -> Result<()> {
    let args: Vec<_> = args.collect();
    let [node, bundle, trial] = args.as_slice() else {
        return Err("usage: t3code-ls-tools probe-startup NODE BUNDLE NEW_TRIAL_DIRECTORY".into());
    };
    let node = fs::canonicalize(node)?;
    let bundle = fs::canonicalize(bundle)?;
    let trial = Path::new(trial);
    fs::create_dir(trial)?;
    let trial = fs::canonicalize(trial)?;
    let base = trial.join("profile");
    let state = base.join("userdata");
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
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let start = Instant::now();
    let mut child = command.spawn()?;
    let outcome = sample(&mut child, &state, start);
    if child.try_wait()?.is_none() {
        child.kill()?;
    }
    child.wait()?;
    let (descriptor_micros, html_micros, database_migration) = outcome?;
    println!(
        "{}",
        json!({
            "schema_version": 1,
            "profile": "new-stock-linux-server-home",
            "poll_interval_micros": POLL_INTERVAL.as_micros(),
            "descriptor_micros": descriptor_micros,
            "html_micros": html_micros,
            "database_migration": database_migration,
        })
    );
    Ok(())
}

fn sample(child: &mut Child, state: &Path, start: Instant) -> Result<(u128, u128, u64)> {
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
    Ok((descriptor_micros, html_micros, migration))
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
            "--fail",
            "--silent",
            "--max-time",
            "1",
        ])
        .arg(format!("{origin}{path}"))
        .output()?;
    Ok(response.status.success().then_some(response.stdout))
}
