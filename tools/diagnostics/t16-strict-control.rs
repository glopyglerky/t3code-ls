//! MIT. Benchmark-only verifier; never changes a product default or opens a database.
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    env, fs,
    io::{self, Read},
    os::unix::fs::MetadataExt,
    path::Path,
    process::Command,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const STOCK: &str = "28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f";
const TREE: &str = "af9112ce82be93109079ca7b7a89f7182455eca5";
const SOURCE: &str = "apps/server/src/persistence/Sqlite.ts";

fn git(root: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err("git source verification failed".into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

// Print an exact-source overlay. The caller writes it only in its owned staging tree.
fn strict_source(root: &Path, plain: bool) -> Result<String> {
    if git(root, &["rev-parse", "HEAD"])?.trim() != STOCK
        || git(root, &["rev-parse", "HEAD^{tree}"])?.trim() != TREE
        || !git(root, &["status", "--porcelain", "--untracked-files=normal"])?.is_empty()
    {
        return Err("expected clean frozen stock staging source".into());
    }
    let source = git(root, &["show", &format!("{STOCK}:{SOURCE}")])?;
    if fs::read_to_string(root.join(SOURCE))? != source {
        return Err("stock working source differs from frozen blob".into());
    }
    policy_overlay(&source, plain)
}

fn policy_overlay(source: &str, plain: bool) -> Result<String> {
    let old = "      yield* sql`PRAGMA synchronous = NORMAL;`;";
    if source.matches(old).count() != 1 {
        return Err("ambiguous synchronous setup".into());
    }
    let new = r#"      // T16 strict-control verifier only. Stock WAL/NORMAL remains the denominator.
      yield* sql`PRAGMA synchronous = FULL;`;
      // Read back on the writer selected by the default SqlClient route.
      // This extra diagnostic work prevents using these samples as plain timings.
      const strictJournal = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode;`;
      const strictSync = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous;`;
      if (strictJournal[0]?.journal_mode !== "wal" || strictSync[0]?.synchronous !== 2) {
        return yield* Effect.die(new Error("T16 strict-control writer is not WAL/FULL"));
      }"#;
    Ok(source.replacen(
        old,
        if plain {
            "      yield* sql`PRAGMA synchronous = FULL;`;"
        } else {
            new
        },
        1,
    ))
}

fn number(value: &Value, field: &str) -> Result<u64> {
    value[field]
        .as_u64()
        .ok_or_else(|| format!("missing unsigned {field}").into())
}
fn finite(value: &Value, field: &str) -> Result<f64> {
    value[field]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or_else(|| format!("missing finite nonnegative {field}").into())
}
fn account(sample: &Value) -> Result<Value> {
    if sample["journey"] != "J02"
        || sample["snapshot"]["valid"] != true
        || sample["fixture"]["threads"] != 32
        || sample["fixture"]["messages_per_thread"] != 200
        || sample["fixture"]["total_messages"] != 6400
        || sample["cpu_rss_qualified"] != false
    {
        return Err("expected verified J02 observation with original qualification scope".into());
    }
    let resource = &sample["resources"];
    let hz = number(resource, "ticks_per_second")?;
    let page = number(resource, "page_size")?;
    let samples = number(resource, "samples")?;
    if hz == 0 || page == 0 || samples == 0 || samples > 10000 {
        return Err("invalid process counter units or sample count".into());
    }
    let mut all = BTreeSet::new();
    let mut groups = serde_json::Map::new();
    for name in ["server", "browser"] {
        let group = &resource[name];
        let processes = group["processes"]
            .as_array()
            .ok_or("missing process identities")?;
        if processes.is_empty() || processes.len() > 256 {
            return Err("invalid process group size".into());
        }
        let mut ticks = 0u64;
        for process in processes {
            let pid = number(process, "pid")?;
            let identity = (pid, number(process, "start_ticks")?);
            if pid == 0 || !all.insert(identity) {
                return Err("invalid, repeated or overlapping process identity".into());
            }
            let delta = number(process, "last_cpu_ticks")?
                .checked_sub(number(process, "baseline_cpu_ticks")?)
                .ok_or("process counter regressed")?;
            ticks = ticks.checked_add(delta).ok_or("CPU total overflow")?;
        }
        let millis = ticks as f64 * 1000.0 / hz as f64;
        if ticks != number(group, "observed_cpu_ticks")?
            || (millis - finite(group, "observed_cpu_millis")?).abs() > 0.000001
        {
            return Err("CPU receipt does not match identity counters and units".into());
        }
        let rss = number(group, "sampled_peak_sum_rss_bytes")?;
        if rss % page != 0 {
            return Err("RSS total is not a page multiple".into());
        }
        groups.insert(
            name.into(),
            json!({"observed_cpu_ticks":ticks,
            "observed_cpu_millis":millis,"sampled_peak_sum_rss_bytes":rss,
            "observed_identities":processes.len()}),
        );
    }
    Ok(
        json!({"schema_version":1,"journey":"J02","accounting":"validated sampled process receipts",
        "groups":groups,"ticks_per_second":hz,"page_size":page,"samples":samples,
        "elapsed_millis":finite(resource,"elapsed_millis")?,
        "max_sample_gap_millis":finite(resource,"max_sample_gap_millis")?,
        "sampler_scan_wall_millis":finite(resource,"sampler_scan_wall_millis")?,
        "sampler_setup_scan_wall_millis":finite(resource,"sampler_setup_scan_wall_millis")?,
        "unavailable_process_reads":number(resource,"unavailable_process_reads")?,
        "baseline_unavailable_process_reads":number(resource,"baseline_unavailable_process_reads")?,
        "cpu_rss_qualified":false,"complete_tree_cpu_qualified":false,"physical_peak_rss_qualified":false,
        "boundary":"Server spawn to final sampler scan after authoritative history and snapshot verification. Browser counters start at the pre-spawn baseline. Server includes root and observed descendants; browser excludes ChromeDriver root.",
        "limits":["Exits between scans and final CPU of exited descendants can be missed; CPU is observed self time, not complete tree usage",
            "RSS is sampled sum, may double count shared pages, misses peaks, and cannot be independently reconstructed from final identity counters",
            "Browser baseline precedes spawn; final scan follows finish request; boundaries differ from descriptor and browser timers",
            "Probe, sampler and ChromeDriver CPU excluded; scan wall time is not sampler CPU",
            "Sampler changes timing and consumes resources; no limiter, total resource or cross-host performance claim"]}),
    )
}

// These marks are completion coordinates, not quantities to normalize away.
// Retain a receipt before refusing unequal work. Background events remain unknown.
fn match_samples(samples: &[Value]) -> Result<Value> {
    if samples.len() != 3 {
        return Err("expected stock, plain FULL, native samples".into());
    }
    let mut rows = Vec::new();
    for (index, sample) in samples.iter().enumerate() {
        account(sample)?;
        let expected = if index == 2 { "native" } else { "stock" };
        let snapshot = &sample["snapshot"];
        let browser = &sample["browser"];
        if sample["profile"] != expected
            || sample["native_lookups"] != false
            || !sample["persistence_spans"].is_null()
            || !sample["readiness_phases"].is_null()
            || snapshot["threadCount"] != 32
            || snapshot["messageCount"] != 200
            || snapshot["selectedThreadId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .is_none()
            || sample["fixture_workspace"]
                .as_str()
                .filter(|s| !s.is_empty())
                .is_none()
        {
            return Err("expected complete plain selected J02 sample".into());
        }
        for field in [
            "runtime_pid_matched",
            "environment_id_matched",
            "html_root_matched",
        ] {
            if sample["readiness_evidence"][field] != true {
                return Err("readiness identity mismatch".into());
            }
        }
        if number(sample, "database_migration")? == 0
            || number(sample, "database_bytes_at_reopen")? == 0
            || number(sample, "descriptor_micros")? == 0
            || number(sample, "html_micros")? < number(sample, "descriptor_micros")?
            || number(&sample["fixture"], "transcript_bytes")? == 0
            || number(sample, "saved_thread_sequence")? == 0
            || number(snapshot, "shellSequence")? == 0
            || number(snapshot, "threadSequence")? == 0
            || number(browser, "threadResumeAfterSequence")?
                != number(sample, "saved_thread_sequence")?
        {
            return Err("incomplete work or completion coordinates".into());
        }
        rows.push(
            json!({"fixture":sample["fixture"],"workspace":sample["fixture_workspace"],
            "snapshot":snapshot,"saved_thread_sequence":sample["saved_thread_sequence"],
            "threadResumeAfterSequence":browser["threadResumeAfterSequence"]}),
        );
    }
    let equivalent = rows[0] == rows[1]
        && rows[0] == rows[2]
        && samples[0]["database_migration"] == samples[1]["database_migration"];
    Ok(
        json!({"journey":"J02","kind":"plain-work-equivalence-control",
        "equivalent_completed_coordinates":equivalent,"arms":["stock","full","native"],"coordinates":rows,
        "sqlite_migrations":[samples[0]["database_migration"],samples[1]["database_migration"]],
        "native_migration":samples[2]["database_migration"],
        "background_events_classified":false,"performance_qualified":false,"equal_durability_qualified":false,
        "limits":["Original probe verifies exact ordered selected history and cache; transcript hashes are checked separately",
        "Sequence divergence blocks this comparison; no normalization or pooling",
        "Matching coordinates do not prove absence of background work or crash durability"]}),
    )
}
fn read_sample(path: &Path) -> Result<Value> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(4_194_305)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 4_194_304 {
        return Err("sample exceeds bound".into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn stopped_footprint(variant: &str, trial: &Path, sample: &Value) -> Result<Value> {
    const SQLITE_FILES: &[&str] = &[
        "statev2.sqlite",
        "statev2.sqlite-wal",
        "statev2.sqlite-shm",
        "statev2.sqlite-journal",
    ];
    const OMDB_FILES: &[&str] = &["statev2.omdb"];
    let (profile, durability, names, other_main) = match variant {
        "stock" => ("stock", "SQLite WAL/NORMAL", SQLITE_FILES, OMDB_FILES[0]),
        "full" => ("stock", "SQLite WAL/FULL", SQLITE_FILES, OMDB_FILES[0]),
        "native" => ("native", "omdb Immediate", OMDB_FILES, SQLITE_FILES[0]),
        _ => return Err("unknown plain comparison variant".into()),
    };
    if sample["journey"] != "J02"
        || sample["profile"] != profile
        || sample["snapshot"]["valid"] != true
    {
        return Err("footprint requires a successful matching J02 sample".into());
    }
    let initial_main = sample["database_bytes_at_reopen"]
        .as_u64()
        .filter(|&bytes| bytes > 0)
        .ok_or("missing apparent size before reopen")?;
    let trial = trial.canonicalize()?;
    let state = trial.join("profile/userdata");
    if state.canonicalize()? != state {
        return Err("unexpected database directory".into());
    }
    match state.join(other_main).symlink_metadata() {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
        Ok(_) => return Err("unexpected competing database".into()),
    }
    let mut files = Vec::new();
    let mut absent = Vec::new();
    let mut apparent_bytes = 0_u64;
    let mut allocated_bytes = 0_u64;
    for (index, &name) in names.iter().enumerate() {
        let metadata = match state.join(name).symlink_metadata() {
            Ok(metadata) => metadata,
            Err(error) if index > 0 && error.kind() == io::ErrorKind::NotFound => {
                absent.push(name);
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file() || (index == 0 && metadata.len() == 0) {
            return Err("expected regular database files and a nonempty main file".into());
        }
        let apparent = metadata.len();
        let allocated = metadata
            .blocks()
            .checked_mul(512)
            .ok_or("block count overflow")?;
        apparent_bytes = apparent_bytes
            .checked_add(apparent)
            .ok_or("apparent size overflow")?;
        allocated_bytes = allocated_bytes
            .checked_add(allocated)
            .ok_or("allocated size overflow")?;
        files.push(json!({"name":name,"apparent_bytes":apparent,"allocated_bytes":allocated}));
    }
    Ok(json!({
        "journey":"J02","variant":variant,"durability":durability,
        "phase":"after the measured reopen and graceful shutdown",
        "before_reopen_main_apparent_bytes":initial_main,
        "files":files,"absent_sidecars":absent,
        "apparent_bytes":apparent_bytes,"allocated_bytes":allocated_bytes,
        "allocation_source":"Linux stat blocks in 512-byte units, main and SQLite sidecars",
        "write_amplification_qualified":false,"compaction_qualified":false,
    }))
}

fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    match args.as_slice() {
        [command, root] if command == "source" => {
            print!("{}", strict_source(Path::new(root), false)?)
        }
        [command, root] if command == "plain-source" => {
            print!("{}", strict_source(Path::new(root), true)?)
        }
        [command, stock, full, native] if command == "match" => {
            let receipt = match_samples(&[
                read_sample(Path::new(stock))?,
                read_sample(Path::new(full))?,
                read_sample(Path::new(native))?,
            ])?;
            println!("{receipt}");
            if receipt["equivalent_completed_coordinates"] != true {
                return Err("unequal completed work; retain receipt and investigate events".into());
            }
        }
        [command, variant, trial, sample] if command == "footprint" => {
            let variant = variant.to_str().ok_or("invalid footprint variant")?;
            println!(
                "{}",
                stopped_footprint(variant, Path::new(trial), &read_sample(Path::new(sample))?)?
            );
        }
        [command] if command == "account" => {
            let mut bytes = Vec::new();
            io::stdin().take(4_194_305).read_to_end(&mut bytes)?;
            if bytes.len() > 4_194_304 {
                return Err("sample exceeds bound".into());
            }
            println!("{}", account(&serde_json::from_slice(&bytes)?)?);
        }
        _ => {
            return Err(
                "usage: t16-strict-control source CLEAN_FROZEN_STOCK | plain-source CLEAN_FROZEN_STOCK | match STOCK FULL NATIVE | footprint VARIANT TRIAL SAMPLE | account < sample.json"
                    .into(),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Value {
        json!({"journey":"J02","snapshot":{"valid":true},"fixture":{"threads":32,"messages_per_thread":200,"total_messages":6400},"cpu_rss_qualified":false,
        "resources":{"ticks_per_second":100,"page_size":4096,"samples":2,"elapsed_millis":75,"max_sample_gap_millis":50,
        "sampler_scan_wall_millis":1,"sampler_setup_scan_wall_millis":1,"unavailable_process_reads":0,"baseline_unavailable_process_reads":0,
        "server":{"observed_cpu_ticks":3,"observed_cpu_millis":30,"sampled_peak_sum_rss_bytes":8192,
        "processes":[{"pid":10,"start_ticks":1,"baseline_cpu_ticks":0,"last_cpu_ticks":3}]},
        "browser":{"observed_cpu_ticks":4,"observed_cpu_millis":40,"sampled_peak_sum_rss_bytes":12288,
        "processes":[{"pid":20,"start_ticks":2,"baseline_cpu_ticks":100,"last_cpu_ticks":104}]}}})
    }
    #[test]
    fn checks_arithmetic_units_and_disjoint_identity_without_promoting_scope() {
        let input = sample();
        let output = account(&input).unwrap();
        assert_eq!(output["groups"]["server"]["observed_cpu_millis"], 30.0);
        assert_eq!(output["cpu_rss_qualified"], false);
        for pointer in [
            "/resources/ticks_per_second",
            "/resources/page_size",
            "/resources/samples",
        ] {
            let mut bad = input.clone();
            *bad.pointer_mut(pointer).unwrap() = json!(0);
            assert!(account(&bad).is_err());
        }
        let mut bad = input.clone();
        bad["resources"]["server"]["observed_cpu_ticks"] = json!(4);
        assert!(account(&bad).is_err());
        let mut bad = input.clone();
        bad["resources"]["browser"]["processes"] =
            input["resources"]["server"]["processes"].clone();
        assert!(account(&bad).is_err());
        let mut bad = input;
        bad["resources"]["server"]["processes"][0]["baseline_cpu_ticks"] = json!(5);
        assert!(account(&bad).is_err());
    }
}

#[cfg(test)]
mod equivalence_tests {
    use super::*;
    fn sample(native: bool) -> Value {
        json!({"journey":"J02","profile":if native {"native"} else {"stock"},"native_lookups":false,
        "persistence_spans":null,"readiness_phases":null,"database_migration":if native {1} else {107},
        "database_bytes_at_reopen":4096,"descriptor_micros":100,"html_micros":101,
        "snapshot":{"valid":true,"threadCount":32,"messageCount":200,"selectedThreadId":"selected","shellSequence":12866,"threadSequence":12866},
        "fixture":{"threads":32,"messages_per_thread":200,"total_messages":6400,"transcript_bytes":42},
        "fixture_workspace":"fixture","saved_thread_sequence":12866,"browser":{"threadResumeAfterSequence":12866},
        "readiness_evidence":{"runtime_pid_matched":true,"environment_id_matched":true,"html_root_matched":true},
        "cpu_rss_qualified":false,"resources":{"ticks_per_second":100,"page_size":4096,"samples":2,
        "elapsed_millis":75,"max_sample_gap_millis":50,"sampler_scan_wall_millis":1,"sampler_setup_scan_wall_millis":1,
        "unavailable_process_reads":0,"baseline_unavailable_process_reads":0,
        "server":{"observed_cpu_ticks":3,"observed_cpu_millis":30,"sampled_peak_sum_rss_bytes":8192,
        "processes":[{"pid":10,"start_ticks":1,"baseline_cpu_ticks":0,"last_cpu_ticks":3}]},
        "browser":{"observed_cpu_ticks":4,"observed_cpu_millis":40,"sampled_peak_sum_rss_bytes":12288,
        "processes":[{"pid":20,"start_ticks":2,"baseline_cpu_ticks":100,"last_cpu_ticks":104}]}}})
    }
    #[test]
    fn plain_overlay_changes_only_synchronous_and_strict_keeps_writer_reads() {
        let source = "before\n      yield* sql`PRAGMA synchronous = NORMAL;`;\nafter\n";
        let plain = policy_overlay(source, true).unwrap();
        assert_eq!(
            plain,
            source.replace("synchronous = NORMAL", "synchronous = FULL")
        );
        let strict = policy_overlay(source, false).unwrap();
        assert!(strict.contains("PRAGMA synchronous = FULL;"));
        assert!(strict.contains("PRAGMA journal_mode;"));
        assert!(strict.contains("PRAGMA synchronous;"));
        assert!(strict.contains("strictSync[0]?.synchronous !== 2"));
        assert!(policy_overlay("no policy", true).is_err());
        assert!(policy_overlay(&source.repeat(2), true).is_err());
    }
    #[test]
    fn matches_completed_coordinates_but_preserves_native_migration_domain() {
        let samples = [sample(false), sample(false), sample(true)];
        assert_eq!(
            match_samples(&samples).unwrap()["equivalent_completed_coordinates"],
            true
        );
        for pointer in [
            "/snapshot/shellSequence",
            "/snapshot/threadSequence",
            "/saved_thread_sequence",
        ] {
            let mut bad = samples.clone();
            *bad[1].pointer_mut(pointer).unwrap() = json!(12867);
            if pointer == "/saved_thread_sequence" {
                bad[1]["browser"]["threadResumeAfterSequence"] = json!(12867);
            }
            assert_eq!(
                match_samples(&bad).unwrap()["equivalent_completed_coordinates"],
                false
            );
        }
        let mut bad = samples.clone();
        bad[1]["snapshot"]["selectedThreadId"] = json!("another");
        assert_eq!(
            match_samples(&bad).unwrap()["equivalent_completed_coordinates"],
            false
        );
        let mut bad = samples.clone();
        bad[1]["database_migration"] = json!(108);
        assert_eq!(
            match_samples(&bad).unwrap()["equivalent_completed_coordinates"],
            false
        );
        let mut bad = samples;
        bad[1]["snapshot"]
            .as_object_mut()
            .unwrap()
            .remove("shellSequence");
        assert!(match_samples(&bad).is_err());
    }
}
