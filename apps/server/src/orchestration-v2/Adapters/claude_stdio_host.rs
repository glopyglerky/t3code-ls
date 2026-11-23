//! Hosted Claude stream-JSON session for the initialize, user, permission and interrupt subset.

use crate::claude_stdio_control::{ControlSession, Incoming, PermissionTicket, ProtocolError};
use crate::json::{self, Value};
use crate::provider_process::{
    Config, Error as ProcessError, StdioChild, drain_stderr, is_blank_frame, read_frame_with_eof,
    stderr_tail,
};
use std::collections::VecDeque;
use std::io::{self, BufReader, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::process::ExitStatus;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const WRITE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Process(ProcessError),
    Protocol(ProtocolError),
    InitializationRejected,
    UnsupportedControl,
}

impl From<ProcessError> for Error {
    fn from(error: ProcessError) -> Self {
        Self::Process(error)
    }
}

impl From<ProtocolError> for Error {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

struct State {
    control: ControlSession,
    initialization: Option<Value>,
    events: VecDeque<Incoming>,
    terminal: Option<Error>,
}

impl State {
    fn check_open(&self) -> Result<(), Error> {
        self.terminal.map_or(Ok(()), Err)
    }

    fn accept(&mut self, event: Incoming, max_queued_messages: usize) -> Result<(), Error> {
        match event {
            Incoming::InitializeResponse {
                success: true,
                response,
            } => {
                self.initialization = Some(response);
            }
            Incoming::InitializeResponse { success: false, .. } => {
                return Err(Error::InitializationRejected);
            }
            Incoming::Message(value)
                if value.get("type").and_then(Value::as_str) == Some("control_request") =>
            {
                return Err(Error::UnsupportedControl);
            }
            Incoming::Ignored => {}
            event => {
                if self.events.len() == max_queued_messages {
                    return Err(ProcessError::QueueFull.into());
                }
                self.events.push_back(event);
            }
        }
        Ok(())
    }
}

struct Shared {
    state: Mutex<State>,
    ready: Condvar,
    json_limits: json::Limits,
    max_queued_messages: usize,
}

impl Shared {
    fn terminate(&self, error: Error) {
        self.state.lock().unwrap().terminal.get_or_insert(error);
        self.ready.notify_all();
    }

    fn read(&self, output: UnixStream) -> Result<(), Error> {
        let mut reader = BufReader::new(output);
        while let Some(line) = read_frame_with_eof(&mut reader, self.json_limits.max_bytes, false)?
        {
            if is_blank_frame(&line) {
                continue;
            }
            let value = json::parse_with_limits(&line, self.json_limits);
            let mut state = self.state.lock().unwrap();
            state.check_open()?;
            let result = value
                .map_err(|_| ProtocolError::InvalidFrame)
                .and_then(|value| state.control.receive_value(value))
                .map_err(Error::from)
                .and_then(|event| state.accept(event, self.max_queued_messages));
            if let Err(error) = result {
                state.terminal = Some(error);
                return Err(error);
            }
            self.ready.notify_all();
        }
        Err(ProcessError::OutputClosed.into())
    }
}

/// Owns one CLI child and its stdio. The SDK adapter continues to own live sessions.
pub struct ClaudeStdioSession {
    shared: Arc<Shared>,
    input: UnixStream,
    child: StdioChild,
    stderr: Arc<Mutex<Vec<u8>>>,
    initialization: Value,
}

impl ClaudeStdioSession {
    /// The caller supplies the executable, stream-JSON arguments and isolated profile.
    pub fn open(config: Config) -> Result<Self, Error> {
        if config.limits.request_timeout.is_zero() {
            return Err(ProcessError::InvalidConfig.into());
        }
        let (child, input, output, errors) = StdioChild::spawn(&config)?;
        let mut control = ControlSession::new(config.limits.max_pending_requests);
        let request = control.request_initialize()?;
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                control,
                initialization: None,
                events: VecDeque::new(),
                terminal: None,
            }),
            ready: Condvar::new(),
            json_limits: json::Limits {
                max_bytes: config.limits.max_frame_bytes,
                ..json::Limits::default()
            },
            max_queued_messages: config.limits.max_queued_messages,
        });
        let mut session = Self {
            shared: shared.clone(),
            input,
            child,
            stderr: Arc::default(),
            initialization: Value::Null,
        };
        let reader_input = session.input.try_clone().map_err(|_| ProcessError::Spawn)?;
        session.child.workers.push(
            thread::Builder::new()
                .name("t3ls-claude-output".to_owned())
                .spawn(move || {
                    if let Err(error) = shared.read(output) {
                        shared.terminate(error);
                        let _ = reader_input.shutdown(Shutdown::Write);
                    }
                })
                .map_err(|_| ProcessError::Spawn)?,
        );
        if !config.inherit_stderr {
            session
                .child
                .workers
                .push(drain_stderr(errors, session.stderr.clone())?);
        }
        session.write(&json::stringify(&request))?;
        session.initialization = session
            .wait_for(config.limits.request_timeout, |state| {
                state.initialization.take()
            })?
            .ok_or(ProcessError::TimedOut)?;
        Ok(session)
    }

    pub fn initialization_response(&self) -> &Value {
        &self.initialization
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn stderr_tail(&self) -> String {
        stderr_tail(&self.stderr)
    }

    /// Sends the caller's user frame unchanged, including UUID, priority and optional fields.
    pub fn offer(&mut self, frame: &str) -> Result<(), Error> {
        let value = self.parse(frame)?;
        let message = value.get("message").ok_or(ProtocolError::InvalidFrame)?;
        if value.get("type").and_then(Value::as_str) != Some("user")
            || message.get("role").and_then(Value::as_str) != Some("user")
            || !matches!(
                message.get("content"),
                Some(Value::String(_) | Value::Array(_))
            )
            || !matches!(
                value.get("parent_tool_use_id"),
                Some(Value::Null | Value::String(_))
            )
        {
            return Err(ProtocolError::InvalidFrame.into());
        }
        self.shared.state.lock().unwrap().check_open()?;
        self.write(frame)
    }

    pub fn interrupt(&mut self) -> Result<String, Error> {
        let request = {
            let mut state = self.shared.state.lock().unwrap();
            state.check_open()?;
            state.control.request_interrupt()?
        };
        let request_id = request
            .get("request_id")
            .and_then(Value::as_str)
            .ok_or(ProtocolError::InvalidFrame)?
            .to_owned();
        self.write(&json::stringify(&request))?;
        Ok(request_id)
    }

    /// A withdrawn, used or superseded ticket produces no write.
    pub fn answer_permission(
        &mut self,
        ticket: &PermissionTicket,
        decision: &str,
    ) -> Result<bool, Error> {
        let decision = self.parse(decision)?;
        match decision.get("behavior").and_then(Value::as_str) {
            Some("allow") => {}
            Some("deny") if decision.get("message").and_then(Value::as_str).is_some() => {}
            _ => return Err(ProtocolError::InvalidFrame.into()),
        }
        let mut state = self.shared.state.lock().unwrap();
        state.check_open()?;
        let Some(answer) = state.control.answer_permission(ticket, decision) else {
            return Ok(false);
        };
        // No queued allow can outlive its ticket. Dispatch and withdrawal share this lock.
        // Once the peer has received a decision, only the peer can revoke its effects.
        let result = write_frame(
            &mut self.input,
            &json::stringify(&answer),
            self.shared.json_limits.max_bytes,
        );
        if let Err(error) = result {
            state.terminal = Some(error.into());
        }
        drop(state);
        self.finish_write(result)?;
        Ok(true)
    }

    /// A timeout is an empty pull. Only the CLI can produce a turn result.
    pub fn poll(&self, timeout: Duration) -> Result<Option<Incoming>, Error> {
        self.wait_for(timeout, |state| state.events.pop_front())
    }

    pub fn close(mut self) -> Result<ExitStatus, Error> {
        self.shared.terminate(ProcessError::Shutdown.into());
        Ok(self.child.shutdown()?)
    }

    fn parse(&self, frame: &str) -> Result<Value, Error> {
        if frame.len() > self.shared.json_limits.max_bytes {
            return Err(ProcessError::FrameTooLarge.into());
        }
        if frame.contains('\n') {
            return Err(ProtocolError::InvalidFrame.into());
        }
        json::parse_with_limits(frame, self.shared.json_limits)
            .map_err(|_| ProtocolError::InvalidFrame.into())
    }

    fn wait_for<T>(
        &self,
        timeout: Duration,
        mut take: impl FnMut(&mut State) -> Option<T>,
    ) -> Result<Option<T>, Error> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(ProcessError::InvalidConfig)?;
        let mut state = self.shared.state.lock().unwrap();
        loop {
            if let Some(event) = take(&mut state) {
                return Ok(Some(event));
            }
            state.check_open()?;
            let wait = deadline.saturating_duration_since(Instant::now());
            if wait.is_zero() {
                return Ok(None);
            }
            (state, _) = self.shared.ready.wait_timeout(state, wait).unwrap();
        }
    }

    fn write(&mut self, frame: &str) -> Result<(), Error> {
        let result = write_frame(&mut self.input, frame, self.shared.json_limits.max_bytes);
        self.finish_write(result)
    }

    fn finish_write(&self, result: Result<(), ProcessError>) -> Result<(), Error> {
        if let Err(error) = result {
            self.shared.terminate(error.into());
            let _ = self.input.shutdown(Shutdown::Write);
            return Err(error.into());
        }
        Ok(())
    }
}

fn write_frame(input: &mut UnixStream, frame: &str, limit: usize) -> Result<(), ProcessError> {
    if frame.len() > limit {
        return Err(ProcessError::FrameTooLarge);
    }
    let deadline = Instant::now() + WRITE_TIMEOUT;
    for mut remaining in [frame.as_bytes(), b"\n"] {
        while !remaining.is_empty() {
            let timeout = deadline.saturating_duration_since(Instant::now());
            if timeout.is_zero() {
                return Err(ProcessError::TimedOut);
            }
            input
                .set_write_timeout(Some(timeout))
                .map_err(|_| ProcessError::Write)?;
            match input.write(remaining) {
                Ok(0) => return Err(ProcessError::Write),
                Ok(count) => remaining = &remaining[count..],
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                    ) =>
                {
                    return Err(ProcessError::TimedOut);
                }
                Err(_) => return Err(ProcessError::Write),
            }
        }
    }
    Ok(())
}
