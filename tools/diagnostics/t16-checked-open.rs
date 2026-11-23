// SPDX-License-Identifier: MIT

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::os::unix::process::CommandExt;
use std::path::{Component, Path};
use std::process::Command;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

// omdb's MultiWriter open acquires this byte before loading the header and
// releases it after publishing the allocator and initializing the handle.
const WRITER_BYTE: &str = "l_start=4611686018427387904, l_len=1}";
const TRACE_CALLS: &str =
    "trace=execve,openat,fcntl,flock,pread64,pwrite64,read,write,fsync,fdatasync,ftruncate";

fn launch(mode: &OsString, database: &Path) -> Result<()> {
    let launcher = std::env::current_exe()?;
    let tools = launcher
        .parent()
        .ok_or("missing diagnostic tool directory")?;
    let helper = tools.join("packaged-db").canonicalize()?;
    let trials = tools
        .parent()
        .ok_or("missing diagnostic directory")?
        .join("trials");
    let allowed_path = if mode == "owner-lock" {
        Path::new("profile/userdata/server-owner.sqlite")
    } else {
        Path::new("profile/userdata/statev2.omdb")
    };
    let relative = database.strip_prefix(trials.canonicalize()?)?;
    let mut components = relative.components();
    if !matches!(components.next(), Some(Component::Normal(_)))
        || components.as_path() != allowed_path
        || database.canonicalize()? != database
    {
        return Err("helper override requires the disposable J02 fixture database".into());
    }
    if mode != "local" {
        return Err(Command::new(helper).arg(mode).arg(database).exec().into());
    }
    let trace = database
        .ancestors()
        .nth(3)
        .ok_or("missing trial directory")?
        .join("checked-open-trace");
    // A second local spawn means a reconnect or a route other than the one being tested.
    fs::create_dir(&trace)?;
    Err(Command::new("/usr/bin/strace")
        .args([
            "-D",
            "-ff",
            "-qq",
            "-ttt",
            "-T",
            "-y",
            "-s",
            "0",
            "--seccomp-bpf",
            "-e",
            TRACE_CALLS,
            "-o",
        ])
        .arg(trace.join("syscalls"))
        .arg("--")
        .arg(helper)
        .arg(mode)
        .arg(database)
        .exec()
        .into())
}

#[derive(Debug)]
struct Event<'a> {
    start: u64,
    duration: u64,
    name: &'a str,
    arguments: &'a str,
    result: i64,
    returned: &'a str,
}

fn micros(value: &str) -> Option<u64> {
    let (seconds, fraction) = value.split_once('.')?;
    if fraction.len() != 6 {
        return None;
    }
    Some(seconds.parse::<u64>().ok()? * 1_000_000 + fraction.parse::<u64>().ok()?)
}

fn syscall(line: &str) -> Option<Event<'_>> {
    let (timestamp, call) = line.split_once(' ')?;
    let (name, remainder) = call.trim_start().split_once('(')?;
    let (arguments, outcome) = remainder.rsplit_once(") = ")?;
    let (returned, duration) = outcome.trim_start().rsplit_once(" <")?;
    let result = returned.split([' ', '<']).next()?.parse().ok()?;
    Some(Event {
        start: micros(timestamp)?,
        duration: micros(duration.strip_suffix('>')?)?,
        name,
        arguments,
        result,
        returned,
    })
}

#[derive(Default)]
struct Traffic {
    successful_calls: u64,
    failed_calls: u64,
    bytes: u64,
    syscall_micros: u64,
}

fn summarize(traces: &[String], file: &str) -> Result<String> {
    let fd_path = format!("<{file}>");
    let quoted_path = format!("\"{file}\"");
    let mut database_events = Vec::new();
    let mut stdin_read = None;
    let mut exec = None;
    for trace in traces {
        let mut is_main = false;
        for line in trace.lines() {
            let Some(event) = syscall(line) else {
                // Ignore signals and incomplete calls outside the database file.
                // A truncated database operation would invalidate the byte counts.
                if line.contains(&fd_path) || line.contains(&quoted_path) {
                    return Err("could not decode a database syscall".into());
                }
                continue;
            };
            if event.name == "execve" && event.result == 0 {
                if exec.replace(event.start).is_some() {
                    return Err(
                        "more than one program executed in the writable helper trace".into(),
                    );
                }
                is_main = true;
            }
            if is_main
                && event.name == "read"
                && event.result > 0
                && (event.arguments.starts_with("0<") || event.arguments.starts_with("0,"))
            {
                stdin_read.get_or_insert(event.start);
            }
            if event.arguments.contains(&fd_path)
                || event.returned.contains(&fd_path)
                || (event.name == "openat" && event.arguments.contains(&quoted_path))
            {
                database_events.push(event);
            }
        }
    }
    let exec = exec.ok_or("missing helper execve")?;
    let stdin_read = stdin_read.ok_or("missing first helper request read")?;
    database_events.sort_by_key(|event| event.start);
    let mut writable = database_events.iter().filter(|event| {
        event.name == "openat"
            && event.arguments.contains("O_RDWR")
            && event.result >= 0
            && event.start < stdin_read
    });
    let open = writable
        .next()
        .ok_or("missing writable open of the fixture database")?
        .start;
    if writable.next().is_some() {
        return Err("multiple writable database opens before the first request".into());
    }
    let writer_lock = |event: &&Event<'_>, operation: &str| {
        event.name == "fcntl"
            && event.result == 0
            && event.arguments.contains("F_OFD_SETLK")
            && event.arguments.contains(operation)
            && event.arguments.contains(WRITER_BYTE)
    };
    let opening: Vec<_> = database_events
        .iter()
        .filter(|event| (open..stdin_read).contains(&event.start))
        .collect();
    let acquired = opening
        .iter()
        .copied()
        .find(|event| writer_lock(event, "l_type=F_WRLCK"))
        .ok_or("missing acquisition of the pinned omdb writer byte")?;
    let released = opening
        .iter()
        .copied()
        .find(|event| event.start > acquired.start && writer_lock(event, "l_type=F_UNLCK"))
        .ok_or("missing release of the pinned omdb writer byte")?;
    let acquire_end = acquired.start + acquired.duration;
    let release_end = released.start + released.duration;
    if !(exec <= open
        && open <= acquire_end
        && acquire_end <= released.start
        && release_end <= stdin_read)
    {
        return Err("checked-open markers are out of order".into());
    }

    let mut phases = [
        BTreeMap::<_, Traffic>::new(),
        BTreeMap::new(),
        BTreeMap::new(),
        BTreeMap::new(),
    ];
    for event in database_events
        .iter()
        .filter(|event| (exec..stdin_read).contains(&event.start))
    {
        let phase = if event.start < open {
            0
        } else if event.start <= acquired.start {
            1
        } else if event.start <= released.start {
            2
        } else {
            3
        };
        let counters = phases[phase].entry(event.name).or_default();
        counters.syscall_micros += event.duration;
        if event.result < 0 {
            counters.failed_calls += 1;
        } else {
            counters.successful_calls += 1;
            if matches!(event.name, "pread64" | "pwrite64" | "read" | "write") {
                counters.bytes += event.result as u64;
            }
        }
    }
    if !phases[2]
        .get("pread64")
        .is_some_and(|traffic| traffic.bytes > 0)
    {
        return Err("writer-locked open did not read database pages".into());
    }
    let elapsed = [
        ("exec_to_writable_open", open - exec),
        ("open_to_writer_acquired", acquire_end - open),
        ("writer_held_through_release", release_end - acquire_end),
        ("after_writer_release_to_request", stdin_read - release_end),
    ];
    let mut result = String::from(
        "phase\telapsed_us\tsyscall\tsuccessful_calls\tfailed_calls\treturned_bytes\ttraced_syscall_us\n",
    );
    for ((phase, duration), calls) in elapsed.into_iter().zip(phases) {
        if calls.is_empty() {
            writeln!(result, "{phase}\t{duration}\t-\t0\t0\t0\t0")?;
        }
        for (name, count) in calls {
            writeln!(
                result,
                "{phase}\t{duration}\t{name}\t{}\t{}\t{}\t{}",
                count.successful_calls, count.failed_calls, count.bytes, count.syscall_micros,
            )?;
        }
    }
    Ok(result)
}

fn run() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match args.as_slice() {
        [command, trial] if command == "summarize" => {
            let trial = Path::new(trial).canonicalize()?;
            let database = trial.join("profile/userdata/statev2.omdb");
            let file = database.to_str().ok_or("non-UTF-8 fixture path")?;
            let mut traces = Vec::new();
            for entry in fs::read_dir(trial.join("checked-open-trace"))? {
                let entry = entry?;
                if entry.file_type()?.is_file()
                    && entry.file_name().to_string_lossy().starts_with("syscalls.")
                {
                    if traces.len() >= 32 || entry.metadata()?.len() > 16 * 1024 * 1024 {
                        return Err("unexpectedly large helper trace".into());
                    }
                    traces.push(fs::read_to_string(entry.path())?);
                }
            }
            print!("{}", summarize(&traces, file)?);
            Ok(())
        }
        [mode, path]
            if matches!(
                mode.to_str(),
                Some("local" | "read-only-local" | "owner-lock")
            ) =>
        {
            launch(mode, Path::new(path))
        }
        _ => Err("usage: t16-checked-open summarize TRIAL_DIRECTORY".into()),
    }
}

fn main() -> Result<()> {
    run()
}

#[cfg(test)]
mod tests {
    use super::summarize;

    const DATABASE: &str = "/tmp/j02/statev2.omdb";
    const MAIN: &str = r#"10.000000 execve("/build/t3-code-ls-db", [...], 0x0 /* 0 vars */) = 0 <0.000010>
10.801000 read(0<socket:[82]>, ""..., 8192) = 48 <0.000100>
"#;
    const WORKER: &str = r#"10.000500 openat(AT_FDCWD, "/tmp/j02/statev2.omdb", O_RDONLY|O_CLOEXEC) = 5</tmp/j02/statev2.omdb> <0.000001>
10.001000 openat(AT_FDCWD, "/tmp/j02/statev2.omdb", O_RDWR|O_CLOEXEC) = 6</tmp/j02/statev2.omdb> <0.000005>
10.002000 fcntl(6</tmp/j02/statev2.omdb>, F_OFD_SETLK, {l_type=F_WRLCK, l_whence=SEEK_SET, l_start=4611686018427387904, l_len=1}) = 0 <0.000010>
10.100000 pread64(6</tmp/j02/statev2.omdb>, ""..., 8192, 0) = 4096 <0.000008>
10.200000 pread64(6</tmp/j02/statev2.omdb>, 0x1, 4096, 4096) = -1 EINTR (Interrupted system call) <0.000006>
10.300000 pread64(6</tmp/j02/statev2.omdb>, ""..., 4096, 4096) = 4096 <0.000004>
10.500000 pwrite64(6</tmp/j02/statev2.omdb>, ""..., 4096, 4096) = 4096 <0.000006>
10.600000 fdatasync(6</tmp/j02/statev2.omdb>) = 0 <0.000100>
10.800000 fcntl(6</tmp/j02/statev2.omdb>, F_OFD_SETLK, {l_type=F_UNLCK, l_whence=SEEK_SET, l_start=4611686018427387904, l_len=1}) = 0 <0.000020>
10.800500 pread64(6</tmp/j02/statev2.omdb>, ""..., 4096, 0) = 4096 <0.000003>
10.802000 pread64(6</tmp/j02/statev2.omdb>, ""..., 4096, 0) = 4096 <0.000003>
"#;

    #[test]
    fn bounds_startup_across_threads_and_counts_only_returned_bytes() {
        let result = summarize(&[WORKER.into(), MAIN.into()], DATABASE).unwrap();
        for row in [
            "exec_to_writable_open\t1000\topenat\t1\t0\t0\t1",
            "open_to_writer_acquired\t1010\tfcntl\t1\t0\t0\t10",
            "writer_held_through_release\t798010\tpread64\t2\t1\t8192\t18",
            "writer_held_through_release\t798010\tpwrite64\t1\t0\t4096\t6",
            "writer_held_through_release\t798010\tfdatasync\t1\t0\t0\t100",
            "after_writer_release_to_request\t980\tpread64\t1\t0\t4096\t3",
        ] {
            assert!(result.lines().any(|line| line == row), "missing {row}");
        }
        assert!(!result.contains(DATABASE));
    }

    #[test]
    fn refuses_missing_writer_boundary_or_incomplete_file_operation() {
        let no_release = WORKER.replace("F_UNLCK", "F_RDLCK");
        assert!(summarize(&[MAIN.into(), no_release], DATABASE).is_err());
        let incomplete = format!("{WORKER}10.700000 pread64(6<{DATABASE}>,  <unfinished ...>\n");
        assert!(summarize(&[MAIN.into(), incomplete], DATABASE).is_err());
    }
}
