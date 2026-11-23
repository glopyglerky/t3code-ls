#![forbid(unsafe_code)]

#[cfg(target_os = "linux")]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    use serde::Deserialize;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::io::{self, BufRead, Read, Write};
    use std::path::PathBuf;
    use t3_code_ls_pty_host::{MAX_CHUNK, PtyOwner};

    #[derive(Deserialize)]
    #[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
    enum Request {
        Spawn {
            executable: PathBuf,
            args: Vec<String>,
            cwd: PathBuf,
            env: BTreeMap<String, String>,
            cols: u16,
            rows: u16,
        },
        Write {
            bytes: Vec<u8>,
        },
        Read,
        Acknowledge {
            end: u64,
        },
        Resize {
            cols: u16,
            rows: u16,
        },
        Close,
    }

    let mut arguments = std::env::args().skip(1);
    if arguments.next().as_deref() != Some("--stdio-v1") || arguments.next().is_some() {
        return Err("usage: t3-code-ls-pty-host --stdio-v1".into());
    }
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut owner: Option<PtyOwner> = None;
    for _ in 0..4096 {
        let mut frame = Vec::new();
        let count = input
            .by_ref()
            .take(128 * 1024 + 1)
            .read_until(b'\n', &mut frame)?;
        if count == 0 {
            return Ok(());
        }
        if count > 128 * 1024 || frame.last() != Some(&b'\n') {
            return Err("PTY request frame exceeds its limit or is truncated".into());
        }
        let request: Request = serde_json::from_slice(&frame)?;
        let response = match request {
            Request::Spawn {
                executable,
                args,
                cwd,
                env,
                cols,
                rows,
            } => {
                if owner.is_some() {
                    return Err("PTY already spawned".into());
                }
                let process = PtyOwner::spawn(&executable, &args, &cwd, &env, cols, rows)?;
                let pid = process.pid();
                owner = Some(process);
                json!({"version":1,"pid":pid})
            }
            command => {
                let process = owner.as_mut().ok_or("PTY has not been spawned")?;
                match command {
                    Request::Write { bytes } => {
                        if bytes.len() > MAX_CHUNK {
                            return Err("input chunk exceeds limit".into());
                        }
                        json!({"version":1,"accepted":process.write(&bytes)?})
                    }
                    Request::Read => {
                        let offered = process.offer()?;
                        json!({"version":1,"start":offered.start,"end":offered.end,
                            "bytes":offered.bytes,"ended":offered.ended})
                    }
                    Request::Acknowledge { end } => {
                        process.acknowledge(end)?;
                        json!({"version":1,"acknowledged":end})
                    }
                    Request::Resize { cols, rows } => {
                        process.resize(cols, rows)?;
                        json!({"version":1,"resized":true})
                    }
                    Request::Close => {
                        let status = process.close()?.ok_or("PTY already closed")?;
                        serde_json::to_writer(
                            &mut output,
                            &json!({"version":1,
                            "exitCode":status.exit_code(),"success":status.success()}),
                        )?;
                        output.write_all(b"\n")?;
                        output.flush()?;
                        return Ok(());
                    }
                    Request::Spawn { .. } => unreachable!(),
                }
            }
        };
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Err("PTY command budget exhausted".into())
}

fn main() {
    #[cfg(target_os = "linux")]
    if let Err(error) = run() {
        eprintln!("t3-code-ls-pty-host: {error}");
        std::process::exit(2);
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("t3-code-ls-pty-host requires the Linux host profile");
        std::process::exit(2);
    }
}
