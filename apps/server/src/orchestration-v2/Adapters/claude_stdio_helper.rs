//! Private parent protocol for a single isolated Claude stream-JSON session.

use crate::claude_stdio_control::{Incoming, PermissionTicket};
use crate::claude_stdio_host::ClaudeStdioSession;
use crate::json::{self, Value};
use crate::provider_process::{Config, Limits, read_frame_with_eof};
use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

const STARTUP_BYTES: usize = 8192;
const FRAME_BYTES: usize = 256 * 1024;
const PENDING_LIMIT: usize = 16;
const EVENT_LIMIT: usize = 16;
const IO_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(15);
const PULL_TIMEOUT: Duration = Duration::from_millis(50);

const CLI_ARGS: &[&str] = &[
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources",
    "",
];

struct Failure {
    stage: &'static str,
    code: String,
}

impl Failure {
    fn new(stage: &'static str, code: impl Into<String>) -> Self {
        Self {
            stage,
            code: code.into(),
        }
    }
}

fn text(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

fn number(value: impl ToString) -> Value {
    Value::Number(value.to_string())
}

fn record<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}

fn reply(kind: &str, value: Value) -> Value {
    record([("type", text(kind)), ("value", value)])
}

fn event(kind: &str, value: Value) -> Value {
    Value::Array(vec![text(kind), value])
}

#[derive(PartialEq, Eq)]
enum Profile {
    Session,
    InitializeOnly,
}

fn startup(line: &str) -> Option<(Profile, Config)> {
    let facts = json::parse_with_limits(
        line,
        json::Limits {
            max_bytes: STARTUP_BYTES,
            max_depth: 2,
            max_values: 8,
        },
    )
    .ok()?;
    let Value::Object(fields) = &facts else {
        return None;
    };
    if fields.len() != 6
        || facts.get("type")?.as_str()? != "open"
        || facts.get("version")?.as_u64()? != 1
    {
        return None;
    }
    let profile = match facts.get("profile")?.as_str()? {
        "session" => Profile::Session,
        "initialize-only" => Profile::InitializeOnly,
        _ => return None,
    };
    let program = PathBuf::from(facts.get("program")?.as_str()?);
    let cwd = PathBuf::from(facts.get("cwd")?.as_str()?);
    let home = PathBuf::from(facts.get("home")?.as_str()?);
    if !program.is_absolute() || !cwd.is_absolute() || !home.is_absolute() {
        return None;
    }
    Some((
        profile,
        Config {
            program,
            args: CLI_ARGS.iter().map(|arg| (*arg).into()).collect(),
            cwd,
            home: Some(home),
            inherit_environment: false,
            inherit_stderr: false,
            track_requests: false,
            environment: vec![(
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
                "1".into(),
            )],
            limits: Limits {
                max_frame_bytes: FRAME_BYTES,
                max_pending_requests: PENDING_LIMIT,
                max_queued_messages: EVENT_LIMIT,
                request_timeout: INITIALIZE_TIMEOUT,
            },
        },
    ))
}

type Input = Result<Option<String>, crate::provider_process::Error>;

struct Wire {
    input: mpsc::Receiver<Input>,
    output: mpsc::SyncSender<String>,
    written: mpsc::Receiver<io::Result<()>>,
    stopping: Arc<AtomicBool>,
}

impl Wire {
    fn open() -> io::Result<Self> {
        let stopping = Arc::new(AtomicBool::new(false));
        for signal in [signal_hook::consts::SIGINT, signal_hook::consts::SIGTERM] {
            signal_hook::flag::register(signal, stopping.clone())?;
        }
        let (send_input, input) = mpsc::sync_channel(0);
        let (output, receive_output) = mpsc::sync_channel::<String>(1);
        let (send_written, written) = mpsc::sync_channel(1);
        // Only this process owns the pipe workers. The session's child is owned by serve().
        thread::Builder::new()
            .name("claude-parent-input".into())
            .spawn(move || {
                let mut input = io::stdin().lock();
                let mut limit = STARTUP_BYTES;
                loop {
                    let result = read_frame_with_eof(&mut input, limit, false);
                    let terminal = !matches!(result, Ok(Some(_)));
                    if send_input.send(result).is_err() || terminal {
                        break;
                    }
                    limit = FRAME_BYTES;
                }
            })?;
        thread::Builder::new()
            .name("claude-parent-output".into())
            .spawn(move || {
                let mut output = io::stdout().lock();
                while let Ok(line) = receive_output.recv() {
                    let result = writeln!(output, "{line}").and_then(|()| output.flush());
                    let closed = result.is_err();
                    if send_written.send(result).is_err() || closed {
                        break;
                    }
                }
            })?;
        Ok(Self {
            input,
            output,
            written,
            stopping,
        })
    }

    fn read(
        &self,
        stage: &'static str,
        deadline: Option<Instant>,
    ) -> Result<Option<String>, Failure> {
        while !self.stopping.load(Ordering::Relaxed) {
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Err(Failure::new(stage, "InputTimedOut"));
            }
            match self.input.recv_timeout(PULL_TIMEOUT) {
                Ok(result) => {
                    return result.map_err(|error| Failure::new(stage, format!("{error:?}")));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        Ok(None)
    }

    fn write(&self, stage: &'static str, value: Value) -> Result<(), Failure> {
        self.output
            .send(json::stringify(&value))
            .map_err(|_| Failure::new(stage, "ParentOutputClosed"))?;
        match self.written.recv_timeout(IO_TIMEOUT) {
            Ok(Ok(())) => Ok(()),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err(Failure::new(stage, "ParentOutputTimedOut"))
            }
            _ => Err(Failure::new(stage, "ParentOutputClosed")),
        }
    }
}

#[derive(Default)]
struct Permissions {
    next_id: u64,
    active: BTreeMap<u64, PermissionTicket>,
}

impl Permissions {
    fn issue(&mut self, ticket: PermissionTicket) -> Result<Value, Failure> {
        if self.active.len() >= PENDING_LIMIT + EVENT_LIMIT {
            return Err(Failure::new("command", "TooManyPermissions"));
        }
        self.next_id = self
            .next_id
            .checked_add(1)
            .filter(|id| *id <= 9_007_199_254_740_991)
            .ok_or_else(|| Failure::new("command", "TicketSequenceExhausted"))?;
        self.active.insert(self.next_id, ticket);
        Ok(number(self.next_id))
    }

    fn withdraw(&mut self, ticket: &PermissionTicket) -> Result<Value, Failure> {
        let id = self
            .active
            .iter()
            .find(|(_, pending)| *pending == ticket)
            .map(|(&id, _)| id)
            .ok_or_else(|| Failure::new("command", "UnknownWithdrawal"))?;
        self.active.remove(&id);
        Ok(number(id))
    }
}

fn command(
    session: &mut ClaudeStdioSession,
    permissions: &mut Permissions,
    kind: Option<&str>,
    request: &Value,
    line: &str,
) -> Result<Value, Failure> {
    let session_error = |error| Failure::new("command", format!("{error:?}"));
    let invalid = || Failure::new("command", "InvalidCommand");
    match kind {
        Some("user") => {
            session.offer(line).map_err(session_error)?;
            Ok(Value::Null)
        }
        Some("interrupt") => Ok(text(session.interrupt().map_err(session_error)?)),
        Some("permission") => {
            let id = request
                .get("ticket")
                .and_then(Value::as_u64)
                .ok_or_else(invalid)?;
            let decision = request.get("decision").ok_or_else(invalid)?;
            let Some(ticket) = permissions.active.get(&id) else {
                return Ok(Value::Bool(false));
            };
            let sent = session
                .answer_permission(ticket, &json::stringify(decision))
                .map_err(session_error)?;
            if sent {
                permissions.active.remove(&id);
            }
            Ok(Value::Bool(sent))
        }
        Some("pull") => Ok(match session.poll(PULL_TIMEOUT).map_err(session_error)? {
            None => Value::Null,
            Some(Incoming::Message(message)) => event("message", message),
            Some(Incoming::BackgroundResult(message)) => event("background", message),
            Some(Incoming::PermissionRequested { ticket, request }) => event(
                "permission",
                Value::Array(vec![permissions.issue(ticket)?, request]),
            ),
            Some(Incoming::PermissionWithdrawn(ticket)) => {
                event("withdrawn", permissions.withdraw(&ticket)?)
            }
            Some(Incoming::InterruptResponse {
                request_id,
                success: true,
                ..
            }) => event("interrupted", text(request_id)),
            Some(Incoming::InterruptResponse { success: false, .. }) => {
                return Err(Failure::new("command", "InterruptRejected"));
            }
            _ => return Err(Failure::new("command", "UnexpectedEvent")),
        }),
        _ => Err(invalid()),
    }
}

fn serve(wire: &Wire) -> Result<(), Failure> {
    let line = wire
        .read("startup", Some(Instant::now() + STARTUP_TIMEOUT))?
        .ok_or_else(|| Failure::new("startup", "MissingStartup"))?;
    let (profile, config) =
        startup(&line).ok_or_else(|| Failure::new("startup", "InvalidStartup"))?;
    let mut session = ClaudeStdioSession::open(config)
        .map_err(|error| Failure::new("startup", format!("{error:?}")))?;
    // Return the fact of a matching initialization receipt, without forwarding its payload.
    wire.write(
        "startup",
        reply(
            "ready",
            record([("version", number(1)), ("pid", number(session.id()))]),
        ),
    )?;

    let mut permissions = Permissions::default();
    let mut explicit_close = false;
    while let Some(line) = wire.read("command", None)? {
        let request = json::parse_with_limits(
            &line,
            json::Limits {
                max_bytes: FRAME_BYTES,
                ..json::Limits::default()
            },
        )
        .map_err(|_| Failure::new("command", "InvalidCommand"))?;
        let kind = request.get("type").and_then(Value::as_str);
        if kind == Some("close") {
            explicit_close = true;
            break;
        }
        if profile == Profile::InitializeOnly {
            return Err(Failure::new("command", "InitializationOnly"));
        }
        let value = command(&mut session, &mut permissions, kind, &request, &line)?;
        wire.write("command", reply("ok", value))?;
    }
    let status = session
        .close()
        .map_err(|error| Failure::new("close", format!("{error:?}")))?;
    if explicit_close {
        use std::os::unix::process::ExitStatusExt;
        wire.write(
            "close",
            reply(
                "closed",
                record([
                    ("code", status.code().map_or(Value::Null, number)),
                    ("signal", status.signal().map_or(Value::Null, number)),
                ]),
            ),
        )?;
    }
    Ok(())
}

pub fn run() -> std::process::ExitCode {
    if std::env::args_os().nth(1).is_some() {
        println!(
            r#"{{"type":"error","value":{{"stage":"startup","code":"UnexpectedArguments"}}}}"#
        );
        return std::process::ExitCode::FAILURE;
    }
    let Ok(wire) = Wire::open() else {
        println!(r#"{{"type":"error","value":{{"stage":"startup","code":"PipeSetup"}}}}"#);
        return std::process::ExitCode::FAILURE;
    };
    match serve(&wire) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(failure) => {
            // A timed-out writer may still own stdout. The session has already been dropped.
            if !matches!(
                failure.code.as_str(),
                "ParentOutputClosed" | "ParentOutputTimedOut"
            ) {
                let _ = wire.write(
                    "close",
                    reply(
                        "error",
                        record([("stage", text(failure.stage)), ("code", text(failure.code))]),
                    ),
                );
            }
            std::process::ExitCode::FAILURE
        }
    }
}
