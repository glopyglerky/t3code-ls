//! MIT. Benchmark-only verifier; never changes a product default or opens a profile.
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    env, fs,
    io::{self, Read},
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
fn strict_source(root: &Path) -> Result<String> {
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
    Ok(source.replacen(old, new, 1))
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

fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    match args.as_slice() {
        [command, root] if command == "source" => print!("{}", strict_source(Path::new(root))?),
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
                "usage: t16-strict-control source CLEAN_FROZEN_STOCK | account < sample.json"
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
