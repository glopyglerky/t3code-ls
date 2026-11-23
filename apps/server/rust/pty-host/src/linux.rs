//! Linux PTY ownership using portable-pty 0.9.0's safe host API.

use nix::fcntl::{FcntlArg, OFlag, fcntl};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use portable_pty::{Child, CommandBuilder, ExitStatus, MasterPty, PtySize, native_pty_system};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

pub const MAX_CHUNK: usize = 8192;
pub const MAX_OUTPUT: u64 = 4 * 1024 * 1024;
const IO_DEADLINE: Duration = Duration::from_millis(250);

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn host(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

fn size(cols: u16, rows: u16) -> io::Result<PtySize> {
    if cols == 0 || rows == 0 {
        return Err(invalid("terminal dimensions must be positive"));
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

pub struct Output<'a> {
    pub start: u64,
    pub end: u64,
    pub bytes: &'a [u8],
    pub ended: bool,
}

/// Retains one unacknowledged output chunk and never interprets terminal bytes.
/// Input acceptance reports the exact prefix written to the kernel.
pub struct PtyOwner {
    child: Option<Box<dyn Child + Send + Sync>>,
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    pid: u32,
    pending: Vec<u8>,
    acknowledged: u64,
    ended: bool,
}

impl PtyOwner {
    pub fn spawn(
        executable: &Path,
        args: &[String],
        cwd: &Path,
        env: &BTreeMap<String, String>,
        cols: u16,
        rows: u16,
    ) -> io::Result<Self> {
        if !executable.is_absolute() || !cwd.is_absolute() || args.len() > 64 || env.len() > 128 {
            return Err(invalid(
                "absolute executable and cwd and bounded arguments are required",
            ));
        }
        let bytes = args.iter().map(String::len).sum::<usize>()
            + env
                .iter()
                .map(|(key, value)| key.len() + value.len())
                .sum::<usize>();
        if bytes > 64 * 1024
            || env
                .keys()
                .any(|key| key.is_empty() || key.contains(['=', '\0']))
        {
            return Err(invalid("invalid argument or environment bounds"));
        }
        let pair = native_pty_system()
            .openpty(size(cols, rows)?)
            .map_err(host)?;
        let fd = pair
            .master
            .as_raw_fd()
            .ok_or_else(|| host("missing master descriptor"))?;
        let flags = fcntl(fd, FcntlArg::F_GETFL).map_err(host)?;
        fcntl(
            fd,
            FcntlArg::F_SETFL(OFlag::from_bits_truncate(flags) | OFlag::O_NONBLOCK),
        )
        .map_err(host)?;
        let reader = pair.master.try_clone_reader().map_err(host)?;
        let writer = pair.master.take_writer().map_err(host)?;
        let mut command = CommandBuilder::new(executable);
        command.args(args);
        command.cwd(cwd);
        command.env_clear();
        for (key, value) in env {
            command.env(key, value);
        }
        let mut child = pair.slave.spawn_command(command).map_err(host)?;
        let pid = match child.process_id() {
            Some(pid) if pid > 0 && pid <= i32::MAX as u32 => pid,
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(host("missing child PID"));
            }
        };
        drop(pair.slave);
        Ok(Self {
            child: Some(child),
            master: pair.master,
            reader,
            writer,
            pid,
            pending: Vec::new(),
            acknowledged: 0,
            ended: false,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        if self.child.is_none() {
            return Err(invalid("terminal is closed"));
        }
        self.master.resize(size(cols, rows)?).map_err(host)
    }

    pub fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_CHUNK || self.child.is_none() {
            return Err(invalid(
                "input exceeds the chunk limit or the terminal is closed",
            ));
        }
        let deadline = Instant::now() + IO_DEADLINE;
        let mut accepted = 0;
        while accepted < bytes.len() {
            match self.writer.write(&bytes[accepted..]) {
                Ok(0) => break,
                Ok(count) => accepted += count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        break;
                    }
                    thread::sleep(Duration::from_millis(1));
                }
                Err(error) if accepted == 0 => return Err(error),
                Err(_) => break,
            }
        }
        Ok(accepted)
    }

    pub fn offer(&mut self) -> io::Result<Output<'_>> {
        if self.pending.is_empty() && !self.ended {
            let mut buffer = [0; MAX_CHUNK];
            match self.reader.read(&mut buffer) {
                Ok(0) => self.ended = true,
                Ok(count) => {
                    if self.acknowledged + count as u64 > MAX_OUTPUT {
                        return Err(invalid("terminal output budget exhausted"));
                    }
                    self.pending.extend_from_slice(&buffer[..count]);
                }
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.kind() == io::ErrorKind::Interrupted => {}
                // Linux reports EIO when every slave descriptor has closed.
                Err(error) if error.raw_os_error() == Some(nix::libc::EIO) => self.ended = true,
                Err(error) => return Err(error),
            }
        }
        Ok(Output {
            start: self.acknowledged,
            end: self.acknowledged + self.pending.len() as u64,
            bytes: &self.pending,
            ended: self.ended,
        })
    }

    pub fn acknowledge(&mut self, end: u64) -> io::Result<()> {
        if end != self.acknowledged + self.pending.len() as u64 {
            return Err(invalid("acknowledgement does not match the offered cursor"));
        }
        self.acknowledged = end;
        self.pending.clear();
        Ok(())
    }

    pub fn close(&mut self) -> io::Result<Option<ExitStatus>> {
        let Some(mut child) = self.child.take() else {
            return Ok(None);
        };
        // portable-pty creates the child as a new session and process-group leader.
        // Keep the leader unreaped until signalling, so its PID cannot be reused.
        let signalled = killpg(Pid::from_raw(self.pid as i32), Signal::SIGKILL);
        let waited = child.wait();
        if let Err(error) = signalled {
            if error != nix::errno::Errno::ESRCH {
                return Err(host(error));
            }
        }
        waited.map(Some)
    }
}

impl Drop for PtyOwner {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
