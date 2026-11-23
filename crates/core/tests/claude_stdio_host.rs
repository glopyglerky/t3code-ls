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
    use t3_code_ls_core::claude_stdio_control::{Incoming, PermissionTicket};
    use t3_code_ls_core::claude_stdio_host::{ClaudeStdioSession, Error};
    use t3_code_ls_core::json::{self, Value};
    use t3_code_ls_core::provider_process::{Config, Error as ProcessError, Limits, read_frame};

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
        let mode = args.next();
        if mode.as_deref() == Some("--fixture") {
            return fixture(&args.next().expect("fixture mode"));
        }

        let directory = env::temp_dir().join(format!("t3ls-claude-fixture-{}", std::process::id()));
        fs::create_dir(&directory).expect("create fresh fixture profile");
        let profile = Profile(directory);
        if mode.as_deref() == Some("--adapter-bridge") {
            return adapter_bridge(&profile.0);
        }
        if mode.as_deref() == Some("--vendor-handshake") {
            let program = PathBuf::from(args.next().expect("pinned Claude executable"));
            assert!(args.next().is_none());
            return vendor_handshake(&profile.0, program);
        }
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

    #[cfg(target_os = "linux")]
    fn vendor_handshake(profile: &Path, program: PathBuf) {
        assert!(program.is_absolute());
        let program = fs::canonicalize(program).expect("resolve the pinned executable");
        let fixture = config(profile, "");
        let input = Config {
            program: program.clone(),
            args: [
                "--print",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--no-session-persistence",
                "--setting-sources",
                "",
            ]
            .into_iter()
            .map(Into::into)
            .collect(),
            environment: vec![(
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
                "1".into(),
            )],
            limits: Limits {
                max_frame_bytes: 256 * 1024,
                request_timeout: Duration::from_secs(15),
                ..fixture.limits
            },
            ..fixture
        };
        let session = ClaudeStdioSession::open(input).expect("vendor CLI initialization receipt");
        assert!(
            matches!(session.initialization_response(), Value::Object(fields) if !fields.is_empty()),
            "Expected a nonempty initialization receipt"
        );
        let process = PathBuf::from(format!("/proc/{}", session.id()));
        assert_eq!(fs::read_link(process.join("exe")).unwrap(), program);
        session.close().expect("close and reap the vendor CLI");
        assert!(!process.exists());
        println!("Pinned vendor CLI acknowledged initialization and was reaped without a prompt.");
    }

    #[cfg(not(target_os = "linux"))]
    fn vendor_handshake(_profile: &Path, _program: PathBuf) {
        panic!("The pinned vendor handshake fixture requires Linux");
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
        if mode == "adapter" {
            reply(&mut output, "foreign-initialize");
        }
        reply(&mut output, &init_id);
        match mode {
            "adapter" => adapter_fixture(&mut input, &mut output),
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

    fn adapter_fixture(input: &mut impl BufRead, output: &mut impl Write) {
        let mut line = String::new();
        let first = read(input, &mut line);
        let uuid = |value: &Value| value.get("uuid").unwrap().as_str().unwrap().to_owned();
        let prompt_uuid = uuid(&first);
        let expected = FIRST
            .replace("first", "First 🌱\\n  keep spacing")
            .replace("11111111-1111-4111-8111-111111111111", &prompt_uuid);
        assert_eq!(line, format!("{expected}\n"));
        assert_eq!(prompt_uuid.len(), 36);
        emit(
            output,
            &line.trim_end().replacen(
                r#"{"type":"user","#,
                r#"{"type":"user","session_id":"fixture","#,
                1,
            ),
        );
        let bash = PERMISSION.replace(
            r#""tool_name":"Read","input":{"file_path":"fixture.txt"}"#,
            r#""tool_name":"Bash","input":{"command":"fixture-only"}"#,
        );
        emit(output, &bash);

        let steer = read(input, &mut line);
        let steer_uuid = uuid(&steer);
        assert_ne!(steer_uuid, prompt_uuid);
        assert_eq!(steer_uuid.len(), 36);
        assert_eq!(
            line,
            format!(
                r#"{{"type":"user","message":{{"role":"user","content":"Steer 🛠️\n  now"}},"parent_tool_use_id":null,"priority":"now","uuid":"{steer_uuid}"}}"#
            ) + "\n"
        );
        emit(
            output,
            &line.trim_end().replacen(
                r#"{"type":"user","#,
                r#"{"type":"user","session_id":"fixture","#,
                1,
            ),
        );
        emit(output, WITHDRAWAL);
        emit(output, &bash.replace("tool-1", "tool-2"));
        let permission = read(input, &mut line);
        check_permission(&permission, "deny");
        let decision = permission.get("response").unwrap().get("response").unwrap();
        assert_eq!(
            decision.get("toolUseID").and_then(Value::as_str),
            Some("tool-2")
        );
        assert_eq!(
            decision
                .get("decisionClassification")
                .and_then(Value::as_str),
            Some("user_reject")
        );

        let result = |uuid: &str, turns: u8, text: &str| {
            format!(
                r#"{{"type":"result","subtype":"success","session_id":"fixture","uuid":"{uuid}","is_error":false,"num_turns":{turns},"duration_ms":1,"duration_api_ms":1,"total_cost_usd":0,"usage":{{"input_tokens":12,"output_tokens":8}},"modelUsage":{{}},"permission_denials":[],"result":"{text}","terminal_reason":"completed""#
            )
        };
        emit(
            output,
            &format!(
                r#"{},"origin":{{"kind":"task-notification"}}}}"#,
                result("33333333-3333-4333-8333-333333333333", 0, "background only")
            ),
        );
        let interrupt = control_id(&read(input, &mut line), "interrupt");
        reply(output, "foreign-interrupt");
        let foreground = format!(
            r#"{},"origin":{{"kind":"human"}},"user_message_uuids":["{prompt_uuid}","{steer_uuid}"]}}"#,
            result("44444444-4444-4444-8444-444444444444", 1, "foreground only")
        );
        emit(output, &foreground);
        emit(output, &foreground);
        reply(output, &interrupt);
        reply(output, &interrupt);
    }

    fn adapter_bridge(profile: &Path) {
        let mut session = ClaudeStdioSession::open(config(profile, "adapter")).unwrap();
        assert_eq!(
            session
                .initialization_response()
                .get("request_id")
                .and_then(Value::as_str),
            Some("t3-initialize-1")
        );
        let mut input = io::stdin().lock();
        let mut output = io::stdout().lock();
        let mut approvals = Vec::<(PermissionTicket, bool)>::new();
        let mut decisions = 0;
        emit(&mut output, r#""ready""#);

        while let Some(line) = read_frame(&mut input, 1024).expect("bounded adapter command") {
            let command = json::parse(&line).unwrap();
            let response = match command.get("type").and_then(Value::as_str).unwrap() {
                "user" => {
                    session.offer(&line).unwrap();
                    Value::Null
                }
                "interrupt" => Value::String(session.interrupt().unwrap()),
                "permission" => {
                    let index = command.get("ticket").and_then(Value::as_u64).unwrap() as usize;
                    let (ticket, withdrawn) = &approvals[index];
                    let decision = command.get("decision").unwrap();
                    let sent = session
                        .answer_permission(ticket, &json::stringify(decision))
                        .unwrap();
                    assert_eq!(sent, !withdrawn);
                    decisions += 1;
                    Value::Bool(sent)
                }
                "pull" => match session.poll(Duration::from_millis(50)).unwrap() {
                    None => Value::Null,
                    Some(Incoming::Message(value)) => event("message", value),
                    Some(Incoming::BackgroundResult(value)) => event("background", value),
                    Some(Incoming::PermissionRequested { ticket, request }) => {
                        assert!(approvals.len() < 2);
                        let id = approvals.len();
                        approvals.push((ticket, false));
                        event("permission", Value::Array(vec![index_value(id), request]))
                    }
                    Some(Incoming::PermissionWithdrawn(ticket)) => {
                        let index = approvals
                            .iter()
                            .position(|(candidate, _)| candidate == &ticket)
                            .unwrap();
                        approvals[index].1 = true;
                        event("withdrawn", index_value(index))
                    }
                    Some(Incoming::InterruptResponse {
                        request_id,
                        success: true,
                        ..
                    }) => event("interrupted", Value::String(request_id)),
                    other => panic!("unexpected fixture event: {other:?}"),
                },
                other => panic!("unexpected adapter command: {other}"),
            };
            emit(&mut output, &json::stringify(&response));
        }

        assert_eq!(decisions, 2);
        assert_reaped(session);
    }

    fn event(kind: &str, payload: Value) -> Value {
        Value::Array(vec![Value::String(kind.to_owned()), payload])
    }

    fn index_value(index: usize) -> Value {
        Value::Number(index.to_string())
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
