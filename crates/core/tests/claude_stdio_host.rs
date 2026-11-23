#[cfg(not(unix))]
fn main() {}

#[cfg(unix)]
fn main() {
    unix::run();
}

#[cfg(unix)]
mod unix {
    use std::env;
    use std::fs;
    use std::io::{self, BufRead, Write};
    use std::os::unix::process::ExitStatusExt;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};
    use t3_code_ls_core::claude_stdio_control::Incoming;
    use t3_code_ls_core::claude_stdio_host::{ClaudeStdioSession, Error};
    use t3_code_ls_core::json::{self, Value};
    use t3_code_ls_core::provider_process::{Config, Error as ProcessError, Limits};

    const WAIT: Duration = Duration::from_secs(5);
    const FIRST: &str = r#"{"type":"user","message":{"role":"user","content":"first"},"parent_tool_use_id":null,"uuid":"11111111-1111-4111-8111-111111111111"}"#;
    const STEER: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"steer"}]},"parent_tool_use_id":null,"priority":"now","uuid":"22222222-2222-4222-8222-222222222222","session_id":"fixture"}"#;
    const PERMISSION: &str = r#"{"type":"control_request","request_id":"permission","request":{"subtype":"can_use_tool","tool_name":"Read","input":{"file_path":"fixture.txt"},"tool_use_id":"tool-1"}}"#;
    const WITHDRAWAL: &str = r#"{"type":"control_cancel_request","request_id":"permission"}"#;
    const TURN: &str = r#"{"type":"result","subtype":"error_during_execution","session_id":"fixture","uuid":"33333333-3333-4333-8333-333333333333"}"#;
    const BACKGROUND: &str = r#"{"type":"result","subtype":"success","session_id":"fixture","origin":{"kind":"task-notification"}}"#;
    const BARRIER: &str = r#"{"type":"system","subtype":"fixture_barrier","session_id":"fixture"}"#;
    const ALLOW: &str = r#"{"behavior":"allow","updatedInput":{"file_path":"fixture.txt"}}"#;
    const DENY: &str = r#"{"behavior":"deny","message":"fixture decision"}"#;

    struct Profile(PathBuf);

    impl Drop for Profile {
        fn drop(&mut self) {
            let result = fs::remove_dir_all(&self.0);
            if !std::thread::panicking() {
                result.expect("remove fixture profile");
            }
        }
    }

    pub fn run() {
        let mut args = env::args().skip(1);
        if args.next().as_deref() == Some("--fixture") {
            return fixture(&args.next().expect("fixture mode"));
        }

        let directory = env::temp_dir().join(format!("t3ls-claude-fixture-{}", std::process::id()));
        fs::create_dir(&directory).expect("create fresh fixture profile");
        let profile = Profile(directory);
        session(&profile.0);
        eprintln!(
            "Claude stdio fixture: user/steer identity, revocation, interrupt order and reap"
        );
        foreign_permission(&profile.0);
        eprintln!("Claude stdio fixture: tickets are scoped to their session");
        framing_failure(&profile.0);
        eprintln!("Claude stdio fixture: bounded frame, queue and shutdown");
        write_failure(&profile.0);
        eprintln!("Claude stdio fixture: blocked input fails within the write budget");
        open_failure(&profile.0);
        eprintln!("Claude stdio fixture: rejected and timed-out initialization");
    }

    fn config(profile: &Path, mode: &str) -> Config {
        Config {
            program: env::current_exe().expect("current test executable"),
            args: vec!["--fixture".into(), mode.into()],
            cwd: profile.into(),
            home: Some(profile.into()),
            inherit_environment: false,
            inherit_stderr: false,
            track_requests: false,
            environment: Vec::new(),
            limits: Limits {
                max_frame_bytes: 1024,
                max_pending_requests: 4,
                max_queued_messages: 8,
                request_timeout: WAIT,
            },
        }
    }

    fn fixture(mode: &str) {
        let mut input = io::stdin().lock();
        let mut output = io::stdout().lock();
        let mut line = String::new();
        let init = read(&mut input, &mut line);
        let init_id = control_id(&init, "initialize");
        match mode {
            "reject" => {
                writeln!(output, r#"{{"type":"control_response","response":{{"subtype":"error","request_id":"{init_id}","error":"fixture rejection"}}}}"#).unwrap();
                output.flush().unwrap();
                return;
            }
            "timeout" => {
                reply(&mut output, "wrong-initialize-id");
                let _ = input.read_line(&mut line).unwrap();
                return;
            }
            _ => {}
        }
        reply(&mut output, &init_id);
        match mode {
            "session" => {
                assert_eq!(read(&mut input, &mut line), json::parse(FIRST).unwrap());
                assert_eq!(line, format!("{FIRST}\n"));
                emit(&mut output, PERMISSION);
                assert_eq!(read(&mut input, &mut line), json::parse(STEER).unwrap());
                assert_eq!(line, format!("{STEER}\n"));
                emit(&mut output, STEER);
                emit(&mut output, WITHDRAWAL);
                emit(&mut output, PERMISSION);
                check_permission(&read(&mut input, &mut line), "deny");
                let first_id = control_id(&read(&mut input, &mut line), "interrupt");
                let second_id = control_id(&read(&mut input, &mut line), "interrupt");
                assert_ne!(first_id, second_id);
                reply(&mut output, "unrelated-interrupt");
                reply(&mut output, &second_id);
                reply(&mut output, &second_id);
                emit(&mut output, TURN);
                reply(&mut output, &first_id);
                emit(&mut output, BACKGROUND);
                emit(&mut output, BARRIER);
            }
            "permission-allow" | "permission-deny" => {
                emit(&mut output, PERMISSION);
                let behavior = mode.strip_prefix("permission-").unwrap();
                check_permission(&read(&mut input, &mut line), behavior);
                emit(&mut output, BARRIER);
            }
            "oversize" => {
                output.write_all(&[b'x'; 1025]).unwrap();
                output.flush().unwrap();
            }
            "queue" => {
                for _ in 0..9 {
                    emit(&mut output, BARRIER);
                }
                line.clear();
                assert_eq!(input.read_line(&mut line).unwrap(), 0);
                fs::write("reader-closed", []).unwrap();
                return;
            }
            "blocked-write" => {
                std::thread::sleep(Duration::from_secs(30));
                panic!("fixture was not reaped after the input deadline");
            }
            "partial" => {
                output.write_all(TURN.as_bytes()).unwrap();
                output.flush().unwrap();
                return;
            }
            _ => panic!("unknown fixture mode"),
        }
        // Keep the output and error descriptors open until the host closes.
        line.clear();
        assert_eq!(input.read_line(&mut line).unwrap(), 0);
    }

    fn read(input: &mut impl BufRead, line: &mut String) -> Value {
        line.clear();
        assert!(input.read_line(line).unwrap() > 0);
        assert!(line.ends_with('\n'));
        json::parse(line).unwrap()
    }

    fn control_id(value: &Value, subtype: &str) -> String {
        assert_eq!(
            value.get("type").and_then(Value::as_str),
            Some("control_request")
        );
        assert_eq!(
            value
                .get("request")
                .unwrap()
                .get("subtype")
                .and_then(Value::as_str),
            Some(subtype)
        );
        value
            .get("request_id")
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn check_permission(value: &Value, behavior: &str) {
        assert_eq!(
            value.get("type").and_then(Value::as_str),
            Some("control_response")
        );
        let response = value.get("response").unwrap();
        assert_eq!(
            response.get("subtype").and_then(Value::as_str),
            Some("success")
        );
        assert_eq!(
            response.get("request_id").and_then(Value::as_str),
            Some("permission")
        );
        assert_eq!(
            response
                .get("response")
                .unwrap()
                .get("behavior")
                .and_then(Value::as_str),
            Some(behavior)
        );
    }

    fn reply(output: &mut impl Write, request_id: &str) {
        emit(
            output,
            &format!(
                r#"{{"type":"control_response","response":{{"subtype":"success","request_id":"{request_id}","response":{{"fixture":true}}}}}}"#
            ),
        );
    }

    fn emit(output: &mut impl Write, line: &str) {
        writeln!(output, "{line}").unwrap();
        output.flush().unwrap();
    }

    fn next(session: &ClaudeStdioSession) -> Incoming {
        session
            .poll(WAIT)
            .expect("fixture output")
            .expect("fixture emitted event")
    }

    fn session(profile: &Path) {
        let mut session = ClaudeStdioSession::open(config(profile, "session")).unwrap();
        assert_eq!(
            session
                .initialization_response()
                .get("response")
                .unwrap()
                .get("fixture"),
            Some(&Value::Bool(true))
        );
        session.offer(FIRST).unwrap();
        let Incoming::PermissionRequested { ticket: old, .. } = next(&session) else {
            panic!("expected first permission request");
        };
        session.offer(STEER).unwrap();
        assert_eq!(
            next(&session),
            Incoming::Message(json::parse(STEER).unwrap())
        );
        assert_eq!(next(&session), Incoming::PermissionWithdrawn(old.clone()));
        let Incoming::PermissionRequested {
            ticket: current, ..
        } = next(&session)
        else {
            panic!("expected reissued permission request");
        };
        assert_ne!(old, current);
        assert!(!session.answer_permission(&old, ALLOW).unwrap());
        assert!(session.answer_permission(&current, DENY).unwrap());
        assert!(!session.answer_permission(&current, ALLOW).unwrap());
        let first = session.interrupt().unwrap();
        let second = session.interrupt().unwrap();
        assert_interrupt(next(&session), &second);
        assert_eq!(
            next(&session),
            Incoming::Message(json::parse(TURN).unwrap())
        );
        assert_interrupt(next(&session), &first);
        assert_eq!(
            next(&session),
            Incoming::BackgroundResult(json::parse(BACKGROUND).unwrap())
        );
        assert_eq!(
            next(&session),
            Incoming::Message(json::parse(BARRIER).unwrap())
        );
        assert_eq!(session.poll(Duration::ZERO).unwrap(), None);
        assert_reaped(session);
    }

    fn assert_interrupt(event: Incoming, id: &str) {
        let Incoming::InterruptResponse {
            request_id,
            success,
            response,
        } = event
        else {
            panic!("expected interrupt receipt, got {event:?}");
        };
        assert_eq!(request_id, id);
        assert!(success);
        assert_eq!(response.get("request_id").and_then(Value::as_str), Some(id));
    }

    fn assert_reaped(session: ClaudeStdioSession) {
        let status = session.close().expect("close and reap owned fixture");
        assert!(status.success() || status.signal() == Some(9), "{status}");
    }

    fn foreign_permission(profile: &Path) {
        let mut left = ClaudeStdioSession::open(config(profile, "permission-allow")).unwrap();
        let mut right = ClaudeStdioSession::open(config(profile, "permission-deny")).unwrap();
        assert_ne!(left.id(), right.id());
        let Incoming::PermissionRequested {
            ticket: left_ticket,
            ..
        } = next(&left)
        else {
            panic!("expected left permission request");
        };
        let Incoming::PermissionRequested {
            ticket: right_ticket,
            ..
        } = next(&right)
        else {
            panic!("expected right permission request");
        };
        assert!(!right.answer_permission(&left_ticket, ALLOW).unwrap());
        assert!(right.answer_permission(&right_ticket, DENY).unwrap());
        assert!(left.answer_permission(&left_ticket, ALLOW).unwrap());
        for session in [left, right] {
            assert_eq!(
                next(&session),
                Incoming::Message(json::parse(BARRIER).unwrap())
            );
            assert_reaped(session);
        }
    }

    fn framing_failure(profile: &Path) {
        let session = ClaudeStdioSession::open(config(profile, "oversize")).unwrap();
        assert_eq!(
            session.poll(WAIT),
            Err(Error::Process(ProcessError::FrameTooLarge))
        );
        assert_reaped(session);

        let session = ClaudeStdioSession::open(config(profile, "queue")).unwrap();
        // The first eight frames remain readable even though the reader has failed closed.
        // Match the ninth output only after the child fills the queue without any pulls.
        let deadline = Instant::now() + WAIT;
        while !profile.join("reader-closed").exists() {
            assert!(
                Instant::now() < deadline,
                "fixture did not observe input shutdown"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        for _ in 0..8 {
            assert_eq!(
                next(&session),
                Incoming::Message(json::parse(BARRIER).unwrap())
            );
        }
        assert_eq!(
            session.poll(WAIT),
            Err(Error::Process(ProcessError::QueueFull))
        );
        assert_reaped(session);

        let session = ClaudeStdioSession::open(config(profile, "partial")).unwrap();
        assert_eq!(
            session.poll(WAIT),
            Err(Error::Process(ProcessError::OutputClosed))
        );
        assert_reaped(session);
    }

    fn write_failure(profile: &Path) {
        let mut config = config(profile, "blocked-write");
        config.limits.max_frame_bytes = 3 * 1024 * 1024;
        let mut session = ClaudeStdioSession::open(config).unwrap();
        let long_prompt = FIRST.replace("first", &"x".repeat(2 * 1024 * 1024));
        let started = Instant::now();
        assert_eq!(
            session.offer(&long_prompt),
            Err(Error::Process(ProcessError::TimedOut))
        );
        assert!(started.elapsed() < WAIT);
        assert_eq!(
            session.poll(Duration::ZERO),
            Err(Error::Process(ProcessError::TimedOut))
        );
        assert_reaped(session);
    }

    fn open_failure(profile: &Path) {
        assert!(matches!(
            ClaudeStdioSession::open(config(profile, "reject")),
            Err(Error::InitializationRejected)
        ));
        let mut config = config(profile, "timeout");
        config.limits.request_timeout = Duration::from_millis(200);
        assert!(matches!(
            ClaudeStdioSession::open(config),
            Err(Error::Process(ProcessError::TimedOut))
        ));
    }
}
