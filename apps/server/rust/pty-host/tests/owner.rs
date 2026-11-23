#![cfg(target_os = "linux")]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use t3_code_ls_pty_host::PtyOwner;

fn spawn(script: &str) -> PtyOwner {
    PtyOwner::spawn(
        Path::new("/bin/sh"),
        &["-c".into(), script.into()],
        Path::new("/tmp"),
        &BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("TERM".into(), "xterm-256color".into()),
        ]),
        80,
        24,
    )
    .unwrap()
}

fn receive(owner: &mut PtyOwner, expected: &[u8]) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut received = Vec::new();
    loop {
        let offered = owner.offer().unwrap();
        let bytes = offered.bytes.to_vec();
        let end = offered.end;
        if !bytes.is_empty() {
            // An output chunk remains available until the destination acknowledges it.
            let repeated = owner.offer().unwrap();
            assert_eq!(repeated.end, end);
            assert_eq!(repeated.bytes, bytes);
            assert!(owner.acknowledge(end + 1).is_err());
            received.extend_from_slice(&bytes);
            owner.acknowledge(end).unwrap();
        }
        if received
            .windows(expected.len())
            .any(|part| part == expected)
        {
            return received;
        }
        assert!(
            Instant::now() < deadline,
            "missing output {expected:?} in {received:?}"
        );
        thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn real_pty_bytes_resize_and_exact_output_acknowledgement() {
    let mut owner = spawn(
        "stty -echo -onlcr; printf '\\033[31mready\\033[0m'; read -r line; printf '%s' \"$line\"; stty size; sleep 30",
    );
    receive(&mut owner, b"\x1b[31mready\x1b[0m");
    owner.resize(117, 43).unwrap();
    assert!(owner.resize(0, 43).is_err());
    let text = "café 👩‍💻 日本語";
    assert_eq!(
        owner.write(format!("{text}\n").as_bytes()).unwrap(),
        text.len() + 1
    );
    let output = receive(&mut owner, b"43 117\n");
    assert!(
        output
            .windows(text.len())
            .any(|part| part == text.as_bytes())
    );
    let pid = owner.pid();
    owner.close().unwrap();
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
    assert!(owner.close().unwrap().is_none());
    assert!(owner.write(b"late").is_err());
}

#[test]
fn explicit_environment_and_drop_kill_and_reap_the_owned_group() {
    let mut owner =
        spawn("test -z \"${HOME+x}\" || exit 19; sleep 30 & printf 'child:%s\\n' \"$!\"; wait");
    let pid = owner.pid();
    let output = receive(&mut owner, b"\r\n");
    let output = String::from_utf8(output).unwrap();
    let descendant: u32 = output
        .trim()
        .strip_prefix("child:")
        .unwrap()
        .parse()
        .unwrap();
    drop(owner);
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
    if let Ok(stat) = std::fs::read_to_string(format!("/proc/{descendant}/stat")) {
        // A killed orphan may await init's reap, but it must no longer execute.
        assert_eq!(stat.split_once(") ").unwrap().1.as_bytes()[0], b'Z');
    }
}

#[test]
fn bounded_write_refuses_to_block_forever() {
    let mut owner = spawn("stty -icanon -echo; printf ready; sleep 30");
    receive(&mut owner, b"ready");
    let start = Instant::now();
    let bytes = [b'x'; 8192];
    let mut found_partial = false;
    for _ in 0..16 {
        if owner.write(&bytes).unwrap() < bytes.len() {
            found_partial = true;
            break;
        }
    }
    assert!(found_partial);
    assert!(start.elapsed() < Duration::from_secs(3));
    assert!(owner.write(&[0; 8193]).is_err());
}

#[test]
fn continuous_output_keeps_only_the_offered_chunk() {
    let mut owner = spawn("exec head -c 5242880 /dev/zero");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut cursor = 0;
    loop {
        let offered = owner.offer().unwrap();
        assert_eq!(offered.start, cursor);
        assert_eq!(offered.end, cursor + offered.bytes.len() as u64);
        assert!(offered.bytes.iter().all(|byte| *byte == 0));
        if offered.ended {
            break;
        }
        let end = offered.end;
        if end == cursor {
            thread::sleep(Duration::from_millis(1));
        } else {
            owner.acknowledge(end).unwrap();
            cursor = end;
        }
        assert!(Instant::now() < deadline, "stopped at byte {cursor}");
    }
    assert_eq!(cursor, 5 * 1024 * 1024);
    assert!(owner.close().unwrap().unwrap().success());
}

#[test]
fn invalid_spawn_and_failed_exec_return_without_a_child() {
    let env = BTreeMap::new();
    for (executable, cwd, cols) in [
        ("relative-shell", "/tmp", 80),
        ("/bin/sh", "relative-directory", 80),
        ("/bin/sh", "/tmp", 0),
        ("/t3-pty-fixture-does-not-exist", "/tmp", 80),
    ] {
        assert!(
            PtyOwner::spawn(Path::new(executable), &[], Path::new(cwd), &env, cols, 24,).is_err()
        );
    }
}

#[test]
fn stdio_transport_eof_closes_its_pty_child() {
    let mut host = Command::new(env!("CARGO_BIN_EXE_t3-code-ls-pty-host"))
        .arg("--stdio-v1")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = host.stdin.take().unwrap();
    writeln!(input, "{}", serde_json::json!({"operation":"spawn", "executable":"/bin/sh", "args":["-c","sleep 30"], "cwd":"/tmp", "env":{"PATH":"/usr/bin:/bin"}, "cols":80,"rows":24})).unwrap();
    let mut response = String::new();
    BufReader::new(host.stdout.take().unwrap())
        .read_line(&mut response)
        .unwrap();
    let pid = serde_json::from_str::<serde_json::Value>(&response).unwrap()["pid"]
        .as_u64()
        .unwrap();
    drop(input);
    assert!(host.wait().unwrap().success());
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
}
