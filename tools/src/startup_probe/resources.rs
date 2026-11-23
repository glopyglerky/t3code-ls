//! Linux observation adapter. Stat fields follow proc_pid_stat(5), fields 14/15/22/24.
//! https://www.kernel.org/doc/html/latest/filesystems/proc.html#process-specific-subdirectories
//! The native resource monitor uses the same final-parenthesis boundary for comm.
use crate::Result;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    process::Command,
    sync::mpsc,
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const INTERVAL: Duration = Duration::from_millis(50);
const DEADLINE: Duration = Duration::from_secs(90);
const MAX_PROCESSES: usize = 4096;
const MAX_STAT_BYTES: u64 = 8192;
const MAX_OWNED_PROCESSES: usize = 256;

type Identity = (u32, u64);

#[derive(Clone, Copy, Debug)]
struct Stat {
    pid: u32,
    parent: u32,
    started: u64,
    ticks: u64,
    rss: u64,
}

impl Stat {
    fn identity(self) -> Identity {
        (self.pid, self.started)
    }
}

fn parse_stat(text: &str) -> Result<Stat> {
    let open = text.find('(').ok_or("missing process comm")?;
    let close = text
        .rfind(')')
        .filter(|close| *close > open)
        .ok_or("invalid process comm")?;
    let pid = text[..open].trim().parse()?;
    let fields: Vec<_> = text[close + 1..].split_ascii_whitespace().collect();
    if fields.len() < 22 {
        return Err("truncated process stat".into());
    }
    let user: u64 = fields[11].parse()?;
    let system: u64 = fields[12].parse()?;
    let rss: i64 = fields[21].parse()?;
    Ok(Stat {
        pid,
        parent: fields[1].parse()?,
        started: fields[19].parse()?,
        ticks: user
            .checked_add(system)
            .ok_or("process CPU counter overflow")?,
        rss: u64::try_from(rss).map_err(|_| "negative process RSS")?,
    })
}

fn process_table() -> Result<(BTreeMap<u32, Stat>, u64)> {
    let mut table = BTreeMap::new();
    let mut unavailable = 0;
    let mut visited = 0;
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        visited += 1;
        if visited > MAX_PROCESSES {
            return Err("resource process table exceeded its 4096-process bound".into());
        }
        let mut bytes = Vec::new();
        let read = File::open(entry.path().join("stat"))
            .and_then(|file| file.take(MAX_STAT_BYTES + 1).read_to_end(&mut bytes));
        match read {
            Ok(_) if bytes.len() <= MAX_STAT_BYTES as usize => {
                let stat = parse_stat(&String::from_utf8_lossy(&bytes))?;
                if stat.pid != pid {
                    return Err("process stat identity disagrees with its directory".into());
                }
                table.insert(pid, stat);
            }
            Ok(_) => return Err("process stat exceeded its byte bound".into()),
            Err(_) => unavailable += 1,
        }
    }
    Ok((table, unavailable))
}

fn system_unit(name: &str) -> Result<u64> {
    let output = Command::new("getconf")
        .arg(name)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .output()?;
    let value = std::str::from_utf8(&output.stdout)?.trim().parse::<u64>()?;
    if !output.status.success() || value == 0 {
        return Err("invalid Linux process counter unit".into());
    }
    Ok(value)
}

struct Observation {
    baseline: u64,
    last: u64,
    role: &'static str,
}

fn process_role(stat: Stat) -> Result<&'static str> {
    let directory = format!("/proc/{}", stat.pid);
    let mut bytes = Vec::new();
    let read = File::open(format!("{directory}/cmdline"))
        .and_then(|file| file.take(MAX_STAT_BYTES + 1).read_to_end(&mut bytes));
    if read.is_err() {
        return Ok("unavailable");
    }
    if bytes.len() > MAX_STAT_BYTES as usize {
        return Ok("command-exceeded-observation-bound");
    }
    let current = std::fs::read_to_string(format!("{directory}/stat"));
    if current
        .as_deref()
        .ok()
        .and_then(|text| parse_stat(text).ok())
        .map(|value| value.identity())
        != Some(stat.identity())
    {
        return Ok("exited-before-role-observation");
    }
    let mut arguments = bytes.split(|byte| *byte == 0);
    let executable = arguments.next().unwrap_or_default();
    if executable.rsplit(|byte| *byte == b'/').next() == Some(b"t3-code-ls-db") {
        return Ok("native-database-helper");
    }
    if arguments.any(|argument| argument == b"--type=renderer") {
        return Ok("browser-renderer");
    }
    Ok("other-process")
}

#[derive(Default)]
struct Group {
    seen: BTreeMap<Identity, Observation>,
    peak_rss_pages: u64,
}

impl Group {
    fn observe(
        &mut self,
        table: &BTreeMap<u32, Stat>,
        root: Identity,
        include_root: bool,
        baseline: &BTreeMap<u32, Stat>,
    ) -> Result<()> {
        if table.get(&root.0).map(|stat| stat.identity()) != Some(root) {
            return Err("owned resource root exited or changed identity".into());
        }
        let mut owned = BTreeSet::from([root]);
        owned.extend(self.seen.keys().copied().filter(|identity| {
            table
                .get(&identity.0)
                .is_some_and(|stat| stat.identity() == *identity)
        }));
        loop {
            let before = owned.len();
            for stat in table.values() {
                if table.get(&stat.parent).is_some_and(|parent| {
                    stat.started >= parent.started && owned.contains(&parent.identity())
                }) {
                    owned.insert(stat.identity());
                }
            }
            if owned.len() > MAX_OWNED_PROCESSES {
                return Err("owned resource tree exceeded its process bound".into());
            }
            if owned.len() == before {
                break;
            }
        }
        if !include_root {
            owned.remove(&root);
        }
        let mut rss = 0u64;
        for identity in owned {
            let Some(stat) = table
                .get(&identity.0)
                .filter(|stat| stat.identity() == identity)
            else {
                continue;
            };
            let initial = baseline
                .get(&stat.pid)
                .filter(|base| base.identity() == identity)
                .map_or(0, |base| base.ticks);
            if !self.seen.contains_key(&identity) && self.seen.len() >= MAX_OWNED_PROCESSES {
                return Err(
                    "resource observation exceeded its retained process identity bound".into(),
                );
            }
            let entry = self.seen.entry(identity).or_insert(Observation {
                baseline: initial,
                last: initial,
                role: "unobserved",
            });
            if stat.ticks < entry.last {
                return Err("owned process CPU counter regressed".into());
            }
            entry.last = stat.ticks;
            rss = rss
                .checked_add(stat.rss)
                .ok_or("process RSS sum overflow")?;
        }
        self.peak_rss_pages = self.peak_rss_pages.max(rss);
        Ok(())
    }

    fn observe_roles(&mut self, table: &BTreeMap<u32, Stat>) -> Result<()> {
        for (identity, process) in &mut self.seen {
            if process.role == "unobserved" {
                process.role = match table
                    .get(&identity.0)
                    .filter(|stat| stat.identity() == *identity)
                {
                    Some(stat) => process_role(*stat)?,
                    None => "exited-before-role-observation",
                };
            }
        }
        Ok(())
    }

    fn report(&self, ticks_per_second: u64, page_size: u64) -> Value {
        let ticks: u64 = self
            .seen
            .values()
            .map(|process| process.last - process.baseline)
            .sum();
        json!({
            "observed_cpu_ticks": ticks,
            "observed_cpu_millis": ticks as f64 * 1000.0 / ticks_per_second as f64,
            "sampled_peak_sum_rss_bytes": self.peak_rss_pages * page_size,
            "processes": self.seen.iter().map(|((pid, started), process)| json!({
                "pid": pid, "start_ticks": started, "baseline_cpu_ticks": process.baseline,
                "last_cpu_ticks": process.last, "role": process.role,
            })).collect::<Vec<_>>(),
        })
    }
}

pub(super) struct Baseline {
    driver: Identity,
    table: BTreeMap<u32, Stat>,
    ticks_per_second: u64,
    page_size: u64,
    baseline_unavailable: u64,
}

impl Baseline {
    pub(super) fn capture(driver_pid: u32) -> Result<Self> {
        let ticks_per_second = system_unit("CLK_TCK")?;
        let page_size = system_unit("PAGESIZE")?;
        let (table, unavailable) = process_table()?;
        let driver = table
            .get(&driver_pid)
            .ok_or("missing owned ChromeDriver root")?
            .identity();
        Ok(Self {
            driver,
            table,
            ticks_per_second,
            page_size,
            baseline_unavailable: unavailable,
        })
    }

    pub(super) fn start(self, server_pid: u32, started: Instant) -> Result<Sampler> {
        let setup_started = Instant::now();
        let (table, _) = process_table()?;
        let server = table
            .get(&server_pid)
            .ok_or("missing newly spawned server root")?
            .identity();
        if self
            .table
            .get(&server_pid)
            .is_some_and(|stat| stat.identity() == server)
        {
            return Err("reopened server predates its resource baseline".into());
        }
        let setup_scan_time = setup_started.elapsed();
        let (stop, stopped) = mpsc::channel();
        let worker = thread::spawn(move || -> std::result::Result<Value, String> {
            self.sample(server, started, setup_scan_time, stopped)
                .map_err(|error| error.to_string())
        });
        Ok(Sampler {
            stop,
            worker: Some(worker),
        })
    }

    fn sample(
        self,
        server: Identity,
        started: Instant,
        setup_scan_time: Duration,
        stopped: mpsc::Receiver<()>,
    ) -> Result<Value> {
        let mut browser = Group::default();
        let mut application = Group::default();
        let mut samples = 0;
        let mut unavailable = 0;
        let mut read_processes = 0;
        let mut scan_time = Duration::ZERO;
        let mut max_gap = Duration::ZERO;
        let mut previous = started;
        let mut finishing = false;
        loop {
            let now = Instant::now();
            if now.duration_since(started) >= DEADLINE {
                return Err("resource observation deadline exceeded".into());
            }
            max_gap = max_gap.max(now.duration_since(previous));
            previous = now;
            let (table, skipped) = process_table()?;
            application.observe(&table, server, true, &self.table)?;
            browser.observe(&table, self.driver, false, &self.table)?;
            application.observe_roles(&table)?;
            browser.observe_roles(&table)?;
            if browser.seen.is_empty() {
                return Err("owned browser process tree was empty".into());
            }
            unavailable += skipped;
            read_processes += table.len();
            samples += 1;
            scan_time += now.elapsed();
            if finishing {
                break;
            }
            match stopped.recv_timeout(INTERVAL) {
                Ok(()) => finishing = true,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("resource observer lost its owner".into());
                }
            }
        }
        Ok(json!({
            "source": "Linux proc_pid_stat fields 14,15,22,24",
            "window": "server spawn through authoritative selected-thread observation and snapshot verification",
            "interval_millis": INTERVAL.as_millis(), "deadline_millis": DEADLINE.as_millis(),
            "max_process_table_entries": MAX_PROCESSES, "max_stat_bytes": MAX_STAT_BYTES,
            "max_observed_identities_per_group": MAX_OWNED_PROCESSES,
            "ticks_per_second": self.ticks_per_second, "page_size": self.page_size,
            "samples": samples, "elapsed_millis": started.elapsed().as_millis(),
            "max_sample_gap_millis": max_gap.as_secs_f64() * 1000.0,
            "sampler_scan_wall_millis": scan_time.as_secs_f64() * 1000.0,
            "sampler_setup_scan_wall_millis": setup_scan_time.as_secs_f64() * 1000.0,
            "process_stat_reads": read_processes, "unavailable_process_reads": unavailable,
            "baseline_unavailable_process_reads": self.baseline_unavailable,
            "server": application.report(self.ticks_per_second, self.page_size),
            "browser": browser.report(self.ticks_per_second, self.page_size),
            "limits": ["CPU is observed process self time and can miss exited short-lived children",
                "RSS is an approximate sampled sum, shared pages can be counted more than once and intervening peaks can be missed",
                "ChromeDriver, measurement runner and sampler CPU are excluded from the two process groups",
                "Sampling overhead is present in these timing observations; scan wall time is retained"],
        }))
    }
}

pub(super) struct Sampler {
    stop: mpsc::Sender<()>,
    worker: Option<JoinHandle<std::result::Result<Value, String>>>,
}

impl Sampler {
    pub(super) fn finish(mut self) -> Result<Value> {
        let _ = self.stop.send(());
        self.worker
            .take()
            .ok_or("missing resource worker")?
            .join()
            .map_err(|_| "resource observer panicked")?
            .map_err(Into::into)
    }
}

impl Drop for Sampler {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stat(pid: u32, parent: u32, started: u64, ticks: u64, rss: u64) -> Stat {
        Stat {
            pid,
            parent,
            started,
            ticks,
            rss,
        }
    }

    #[test]
    fn process_stat_handles_comm_parentheses_and_uses_self_counters() {
        let mut fields = vec!["0"; 22];
        fields[0] = "S";
        fields[1] = "7";
        fields[11] = "12";
        fields[12] = "8";
        fields[13] = "9000";
        fields[14] = "8000";
        fields[19] = "456";
        fields[21] = "24";
        let parsed = parse_stat(&format!("42 (browser ) worker) {}", fields.join(" "))).unwrap();
        assert_eq!(
            (
                parsed.pid,
                parsed.parent,
                parsed.started,
                parsed.ticks,
                parsed.rss
            ),
            (42, 7, 456, 20, 24)
        );
        assert!(parse_stat("42 (truncated) S 7").is_err());
        fields[21] = "-1";
        assert!(parse_stat(&format!("42 (negative) {}", fields.join(" "))).is_err());
    }

    #[test]
    fn tree_totals_exclude_unrelated_work_and_fence_reused_pids() {
        let baseline = BTreeMap::from([
            (10, stat(10, 1, 10, 100, 10)),
            (11, stat(11, 10, 11, 40, 20)),
        ]);
        let mut group = Group::default();
        let first = BTreeMap::from([
            (10, stat(10, 1, 10, 110, 10)),
            (11, stat(11, 10, 11, 50, 20)),
            (12, stat(12, 11, 12, 3, 30)),
            (99, stat(99, 1, 99, 900, 900)),
        ]);
        group.observe(&first, (10, 10), false, &baseline).unwrap();
        assert_eq!(group.report(100, 4096)["observed_cpu_ticks"], 13);
        assert_eq!(group.peak_rss_pages, 50);
        let second = BTreeMap::from([
            (10, stat(10, 1, 10, 120, 10)),
            (11, stat(11, 1, 11, 55, 15)),
            (12, stat(12, 99, 120, 500, 100)),
        ]);
        group.observe(&second, (10, 10), false, &baseline).unwrap();
        assert_eq!(group.report(100, 4096)["observed_cpu_ticks"], 18);
        assert_eq!(group.seen.len(), 2);
        assert_eq!(group.peak_rss_pages, 50);
        let mut reused_parent = second.clone();
        reused_parent.insert(50, stat(50, 10, 5, 900, 900));
        group
            .observe(&reused_parent, (10, 10), false, &baseline)
            .unwrap();
        assert!(!group.seen.contains_key(&(50, 5)));
        assert!(
            group
                .observe(&second, (10, 1000), false, &baseline)
                .is_err()
        );
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn kernel_process_table_tracks_an_owned_child_without_charging_its_parent() {
        let child = super::super::OwnedChild(Command::new("/bin/sleep").arg("10").spawn().unwrap());
        let (table, _) = process_table().unwrap();
        let child_stat = *table.get(&child.0.id()).unwrap();
        assert_eq!(child_stat.parent, std::process::id());
        let mut group = Group::default();
        group
            .observe(&table, child_stat.identity(), true, &BTreeMap::new())
            .unwrap();
        group.observe_roles(&table).unwrap();
        assert_eq!(group.seen.len(), 1);
        assert!(group.seen.contains_key(&child_stat.identity()));
        assert_eq!(group.peak_rss_pages, child_stat.rss);
        assert!(system_unit("CLK_TCK").unwrap() > 0);
        assert!(system_unit("PAGESIZE").unwrap() > 0);
    }
}
