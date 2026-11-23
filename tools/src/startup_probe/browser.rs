use crate::Result;
use serde_json::{Value, json};
use std::{
    env,
    fs::{self, File},
    io::Write,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use super::OwnedChild;

mod conversation;

const WINDOW_WAIT: Duration = Duration::from_secs(30);
const ELEMENT: &str = "element-6066-11e4-a52e-4f735466cecf";

pub(super) struct Browser {
    driver: OwnedChild,
    origin: String,
    session: String,
}

impl Browser {
    pub(super) fn start(driver: &Path, chrome: &Path, trial: &Path) -> Result<Self> {
        let chrome = fs::canonicalize(chrome)?;
        let startup = trial.join("webdriver-startup.log");
        let output = File::create_new(&startup)?;
        let mut driver = OwnedChild(
            Command::new(driver)
                .arg("--port=0")
                .env_clear()
                .env("PATH", env::var_os("PATH").ok_or("missing PATH")?)
                .env("HOME", trial)
                .stdin(Stdio::null())
                .stdout(output)
                .stderr(Stdio::null())
                .spawn()?,
        );
        let start = Instant::now();
        let port = loop {
            if let Some(status) = driver.0.try_wait()? {
                return Err(format!("ChromeDriver exited before binding: {status}").into());
            }
            if let Some(port) = fs::read_to_string(&startup)?.lines().find_map(|line| {
                line.strip_prefix("ChromeDriver was started successfully on port ")?
                    .trim_end_matches('.')
                    .parse::<u16>()
                    .ok()
                    .filter(|port| *port != 0)
            }) {
                break port;
            }
            if start.elapsed() >= WINDOW_WAIT {
                return Err("ChromeDriver did not publish its loopback port".into());
            }
            thread::sleep(Duration::from_millis(20));
        };
        let origin = format!("http://127.0.0.1:{port}");
        let result = request(
            &origin,
            "POST",
            "/session",
            Some(json!({
                "capabilities": {"alwaysMatch": {
                    "browserName": "chrome",
                    "pageLoadStrategy": "eager",
                    "timeouts": {"pageLoad": 20_000, "script": 5_000},
                    "goog:chromeOptions": {
                        "binary": chrome,
                        "args": ["--headless", "--window-size=1280,900", "--lang=en-US", "--disable-background-networking"],
                        "prefs": {"intl.accept_languages": "en-US,en"},
                    },
                }},
            })),
        )?;
        let session = result["sessionId"]
            .as_str()
            .filter(|session| !session.is_empty() && session.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("ChromeDriver did not return a valid session ID")?;
        Ok(Self {
            driver,
            origin,
            session: session.to_owned(),
        })
    }

    pub(super) fn attach(
        &self,
        link: &str,
        server_started: Instant,
        replay: bool,
    ) -> Result<Value> {
        let navigation_started = Instant::now();
        self.command("POST", "/url", Some(json!({"url": link})))?;
        self.wait_for("the authenticated welcome page", || self.script(
            "return location.pathname === '/welcome' && [...document.querySelectorAll('h1')].some(e => e.textContent.trim() === 'Welcome to T3 Code' && e.getClientRects().length > 0);",
        ).map(|value| value == true))?;
        let welcome_micros = server_started.elapsed().as_micros();
        let navigation_to_welcome_micros = navigation_started.elapsed().as_micros();

        if replay {
            self.wait_for("the replay provider and completed welcome scan", || {
                self.script("const text = document.querySelector('main, [role=main]')?.innerText; return !!text && text.includes('Replay (dev)') && !text.includes('Looking for projects');").map(|value| value == true)
            })?;
        }
        let action = match replay {
            true => {
                "return [...document.querySelectorAll('button')].find(e => !e.disabled && e.textContent.trim() === 'Start' && e.getClientRects().length > 0) ?? null;"
            }
            false => {
                "return [...document.querySelectorAll('button')].find(e => !e.disabled && e.textContent.trim() === 'Start without an agent' && e.getClientRects().length > 0) ?? null;"
            }
        };
        let element = self.wait_element("the welcome action", action)?;
        let setup_started = Instant::now();
        self.command(
            "POST",
            &format!("/element/{element}/click"),
            Some(json!({})),
        )?;
        self.wait_for("the empty workspace and Add project control", || self.script(
            "const main = document.querySelector('main, [role=main]'); return location.pathname === '/' && !!main && main.innerText.includes('What should we work on?') && [...main.querySelectorAll('button')].some(e => !e.disabled && e.textContent.trim() === 'Add project' && e.getClientRects().length > 0);",
        ).map(|value| value == true))?;
        let workspace_micros = server_started.elapsed().as_micros();
        let setup_micros = setup_started.elapsed().as_micros();
        let authenticated = self.command("POST", "/execute/async", Some(json!({
            "script": "const done = arguments[arguments.length - 1]; fetch('/api/auth/session', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).then(session => done(session?.authenticated === true), () => done(false));",
            "args": [],
        })))?;
        if authenticated != true {
            return Err("first workspace could not read an authenticated session".into());
        }
        let loaded_rust_composer = self.script(
            "return performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.endsWith('/client-text-wasm/composer_offsets_bg.wasm'));",
        )?;
        Ok(json!({
            "welcome_micros": welcome_micros,
            "navigation_to_welcome_micros": navigation_to_welcome_micros,
            "setup_micros": setup_micros,
            "workspace_micros": workspace_micros,
            "authenticated": true,
            "loaded_rust_composer": loaded_rust_composer == true,
        }))
    }

    pub(super) fn close(mut self) -> Result<()> {
        self.command("DELETE", "", None)?;
        self.session.clear();
        self.driver.stop()
    }

    fn script(&self, script: &str) -> Result<Value> {
        self.script_with_args(script, json!([]))
    }

    fn script_with_args(&self, script: &str, args: Value) -> Result<Value> {
        self.command(
            "POST",
            "/execute/sync",
            Some(json!({"script": script, "args": args})),
        )
    }

    fn wait_element(&self, label: &str, script: &str) -> Result<String> {
        let mut found = None;
        self.wait_for(label, || {
            found = self.script(script)?[ELEMENT].as_str().map(str::to_owned);
            Ok(found.is_some())
        })?;
        found.ok_or_else(|| format!("missing {label}").into())
    }

    fn command(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        request(
            &self.origin,
            method,
            &format!("/session/{}{path}", self.session),
            body,
        )
    }

    fn wait_for(&self, label: &str, mut predicate: impl FnMut() -> Result<bool>) -> Result<()> {
        let start = Instant::now();
        while !predicate()? {
            if start.elapsed() >= WINDOW_WAIT {
                return Err(format!("timed out waiting for {label}").into());
            }
            thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        if !self.session.is_empty() {
            let _ = self.command("DELETE", "", None);
        }
    }
}

fn request(origin: &str, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
    let mut command = Command::new("curl");
    command
        .args([
            "-q",
            "--noproxy",
            "*",
            "--silent",
            "--max-time",
            "25",
            "--request",
            method,
        ])
        .arg(format!("{origin}{path}"))
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if body.is_some() {
        // Put the pairing URL on stdin. It does not belong in process arguments or logs.
        command.args([
            "--header",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
        ]);
        command.stdin(Stdio::piped());
    }
    let mut process = command.spawn()?;
    if let Some(body) = body {
        process
            .stdin
            .take()
            .ok_or("missing WebDriver request pipe")?
            .write_all(&serde_json::to_vec(&body)?)?;
    }
    let response = process.wait_with_output()?;
    if !response.status.success() {
        return Err(format!("WebDriver request failed: {}", response.status).into());
    }
    let mut document: Value = serde_json::from_slice(&response.stdout)?;
    let result = document
        .get_mut("value")
        .ok_or("WebDriver response has no value")?
        .take();
    if let Some(error) = result["error"].as_str() {
        return Err(format!("WebDriver rejected {method}: {error}").into());
    }
    Ok(result)
}
