//! Linux observation adapter. Stat fields follow proc_pid_stat(5), fields 14/15/22/24.
//! https://www.kernel.org/doc/html/latest/filesystems/proc.html#process-specific-subdirectories
//! The native resource monitor uses the same final-parenthesis boundary for comm.
use super::browser::Browser;
use crate::Result;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs::File,
    io::Read,
    path::Path,
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

struct RoleWitness {
    role: &'static str,
    layout: &'static str,
    image: Option<String>,
    process_type: Option<&'static str>,
}

impl RoleWitness {
    fn missing(role: &'static str) -> Self {
        Self {
            role,
            layout: "unavailable",
            image: None,
            process_type: None,
        }
    }

    fn report(&self, stat: Stat) -> Value {
        json!({
            "pid": stat.pid, "start_ticks": stat.started,
            "role": self.role, "command_layout": self.layout,
            "image_basename": self.image, "process_type": self.process_type,
        })
    }
}

// Chromium rewrites Linux argv into a process title.
// https://chromium.googlesource.com/chromium/src/+/HEAD/base/process/set_process_title_linux_unittest.cc
fn command_role(bytes: &[u8], image: &str) -> RoleWitness {
    let args: Vec<_> = bytes
        .split(|byte| *byte == 0)
        .filter(|arg| !arg.is_empty())
        .collect();
    let flattened = args.len() == 1 && args[0].contains(&b' ');
    let tokens: Vec<_> = if flattened {
        args[0]
            .split(u8::is_ascii_whitespace)
            .filter(|arg| !arg.is_empty())
            .collect()
    } else {
        args
    };
    let types: Vec<_> = tokens
        .iter()
        .filter_map(|arg| arg.strip_prefix(b"--type="))
        .collect();
    let process_type = match types.as_slice() {
        [value] if *value == b"renderer" => Some("renderer"),
        [value] if *value == b"zygote" => Some("zygote"),
        [value] if *value == b"gpu-process" => Some("gpu-process"),
        [value] if *value == b"utility" => Some("utility"),
        [] => None,
        _ => Some("other-or-ambiguous"),
    };
    let role = if image == "t3-code-ls-db" {
        "native-database-helper"
    } else if matches!(image, "chrome" | "chromium" | "chromium-browser")
        && process_type == Some("renderer")
    {
        "browser-renderer"
    } else {
        "other-process"
    };
    RoleWitness {
        role,
        layout: if flattened {
            "flattened-process-title"
        } else {
            "nul-separated-argv"
        },
        image: Some(image.to_owned()),
        process_type,
    }
}

fn process_witness(stat: Stat) -> Result<RoleWitness> {
    let directory = format!("/proc/{}", stat.pid);
    let mut bytes = Vec::new();
    let read = File::open(format!("{directory}/cmdline"))
        .and_then(|file| file.take(MAX_STAT_BYTES + 1).read_to_end(&mut bytes));
    if read.is_err() {
        return Ok(RoleWitness::missing("unavailable"));
    }
    if bytes.len() > MAX_STAT_BYTES as usize {
        return Ok(RoleWitness::missing("command-exceeded-observation-bound"));
    }
    let image = std::fs::read_link(format!("{directory}/exe"));
    let mut current = Vec::new();
    let read = File::open(format!("{directory}/stat"))
        .and_then(|file| file.take(MAX_STAT_BYTES + 1).read_to_end(&mut current));
    if read.is_err()
        || current.len() > MAX_STAT_BYTES as usize
        || std::str::from_utf8(&current)
            .ok()
            .and_then(|text| parse_stat(text).ok())
            .map(|value| value.identity())
            != Some(stat.identity())
    {
        return Ok(RoleWitness::missing("exited-before-role-observation"));
    }
    let image = image
        .ok()
        .and_then(|image| image.file_name()?.to_str().map(str::to_owned));
    Ok(match image {
        Some(image) => command_role(&bytes, &image),
        None => RoleWitness::missing("unavailable-image"),
    })
}

fn process_role(stat: Stat) -> Result<&'static str> {
    Ok(process_witness(stat)?.role)
}

pub(crate) fn run_browser_witness(args: impl Iterator<Item = OsString>) -> Result<()> {
    let args: Vec<_> = args.collect();
    let [driver, chrome, trial] = args.as_slice() else {
        return Err("usage: t3code-ls-tools probe-browser-resources CHROMEDRIVER CHROME NEW_TRIAL_DIRECTORY".into());
    };
    if !cfg!(target_os = "linux") {
        return Err("browser resource witnesses require Linux".into());
    }
    std::fs::create_dir(trial)?;
    let trial = std::fs::canonicalize(trial)?;
    let browser = Browser::start(Path::new(driver), Path::new(chrome), &trial)?;
    browser.open_resource_fixture()?;
    let mut group = Group::default();
    let started = Instant::now();
    let (initial, _) = process_table()?;
    let root = initial
        .get(&browser.driver_pid())
        .ok_or("missing owned browser root")?
        .identity();
    let mut witnesses = Value::Null;
    let mut observed = false;
    let mut samples = 0;
    while started.elapsed() < Duration::from_secs(10) {
        let (table, _) = process_table()?;
        group.observe(&table, root, false, &BTreeMap::new())?;
        group.observe_roles(&table, process_role)?;
        witnesses = Value::Array(
            group
                .seen
                .keys()
                .filter_map(|identity| {
                    table
                        .get(&identity.0)
                        .filter(|stat| stat.identity() == *identity)
                })
                .map(|stat| process_witness(*stat).map(|witness| witness.report(*stat)))
                .collect::<Result<Vec<_>>>()?,
        );
        samples += 1;
        observed = group
            .seen
            .values()
            .any(|process| process.role == "browser-renderer");
        if observed {
            break;
        }
        thread::sleep(INTERVAL);
    }
    browser.close()?;
    println!(
        "{}",
        json!({
            "schema_version": 1, "renderer_witnessed": observed, "samples": samples,
            "elapsed_millis": started.elapsed().as_millis(),
            "root_pid": root.0, "root_start_ticks": root.1,
            "witnesses": witnesses,
            "scope": "Owned ChromeDriver descendants on a synthetic data page",
        })
    );
    if !observed {
        return Err("No attributed renderer process was observed".into());
    }
    Ok(())
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

    fn observe_roles(
        &mut self,
        table: &BTreeMap<u32, Stat>,
        mut read_role: impl FnMut(Stat) -> Result<&'static str>,
    ) -> Result<()> {
        for (identity, process) in &mut self.seen {
            // Zygote children can acquire their renderer command line after the first sample.
            // Keep checking live, unclassified identities until a specific role is witnessed.
            if matches!(process.role, "browser-renderer" | "native-database-helper") {
                continue;
            }
            if let Some(stat) = table
                .get(&identity.0)
                .filter(|stat| stat.identity() == *identity)
            {
                process.role = read_role(*stat)?;
            } else if process.role == "unobserved" {
                process.role = "exited-before-role-observation";
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
            application.observe_roles(&table, process_role)?;
            browser.observe_roles(&table, process_role)?;
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
    fn chrome_roles_accept_process_titles_with_an_image_and_exact_type() {
        for bytes in [
            b"/opt/google/chrome/chrome\0--type=renderer\0--lang=en-US\0".as_slice(),
            b"/opt/google/chrome/chrome --type=renderer --lang=en-US\0\0".as_slice(),
        ] {
            assert_eq!(command_role(bytes, "chrome").role, "browser-renderer");
            assert_eq!(command_role(bytes, "unrelated").role, "other-process");
        }
        for bytes in [
            b"chrome\0--title=fixture --type=renderer\0".as_slice(),
            b"chrome --type=renderer-other\0".as_slice(),
            b"chrome --type=renderer --type=zygote\0".as_slice(),
        ] {
            assert_eq!(command_role(bytes, "chrome").role, "other-process");
        }
        assert_eq!(
            command_role(b"/fixture/helper\0", "t3-code-ls-db").role,
            "native-database-helper"
        );
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
    #[test]
    fn role_observation_refreshes_live_children_and_keeps_identity_bound_witnesses() {
        let root = stat(10, 1, 10, 10, 10);
        let child = stat(11, 10, 11, 4, 20);
        let helper = stat(12, 10, 12, 5, 30);
        let table = BTreeMap::from([(10, root), (11, child), (12, helper)]);
        let mut group = Group::default();
        group
            .observe(&table, root.identity(), false, &BTreeMap::new())
            .unwrap();
        group
            .observe_roles(&table, |_| Ok("other-process"))
            .unwrap();
        assert_eq!(group.seen[&child.identity()].role, "other-process");
        assert_eq!(group.seen[&helper.identity()].role, "other-process");

        let mut classified = Vec::new();
        group
            .observe_roles(&table, |stat| {
                classified.push(stat.identity());
                Ok(if stat.pid == child.pid {
                    "browser-renderer"
                } else {
                    "native-database-helper"
                })
            })
            .unwrap();
        assert_eq!(classified, [child.identity(), helper.identity()]);
        assert_eq!(group.seen[&child.identity()].role, "browser-renderer");
        assert_eq!(
            group.seen[&helper.identity()].role,
            "native-database-helper"
        );
        group
            .observe_roles(&table, |_| panic!("specific witnesses must be retained"))
            .unwrap();

        let replacement = stat(child.pid, 99, 111, 400, 900);
        let reused = BTreeMap::from([(10, root), (11, replacement)]);
        group
            .observe_roles(&reused, |_| panic!("reused PID must not replace a witness"))
            .unwrap();
        assert_eq!(group.seen[&child.identity()].role, "browser-renderer");
        assert_eq!(group.report(100, 4096)["observed_cpu_ticks"], 9);

        let mut unclassified = Group::default();
        unclassified
            .observe(&table, root.identity(), false, &BTreeMap::new())
            .unwrap();
        unclassified
            .observe_roles(&table, |_| Ok("unavailable"))
            .unwrap();
        unclassified
            .observe_roles(&reused, |_| {
                panic!("reused PID cannot classify an old identity")
            })
            .unwrap();
        assert_eq!(unclassified.seen[&child.identity()].role, "unavailable");
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
        group.observe_roles(&table, process_role).unwrap();
        assert_eq!(group.seen.len(), 1);
        assert!(group.seen.contains_key(&child_stat.identity()));
        assert_eq!(group.peak_rss_pages, child_stat.rss);
        assert!(system_unit("CLK_TCK").unwrap() > 0);
        assert!(system_unit("PAGESIZE").unwrap() > 0);
    }
}
