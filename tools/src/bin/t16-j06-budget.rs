//! MIT. Budget check for the balanced, completed J06 browser workload.
use serde_json::{Value, json};
use std::{collections::BTreeSet, env, fs::File, io::Read, path::Path};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const ROUNDS: usize = 6;
const BATCH: &str = "turn-start-batch";
const RECEIPTS: &str = "receipt-reads";
const METRICS: [&str; 5] = [
    "accept_ack_ms",
    "first_visible_ms",
    "terminal_ms",
    "max_frame_gap_ms",
    "browser_reload_us",
];
const MAX_STOCK_RATIO: f64 = 1.0;
const HEADER: &str = "pair\tposition\tprofile\taccept_ack_ms\tfirst_visible_ms\tterminal_ms\tmax_frame_gap_ms\tbrowser_reload_us";

fn policy(variant: &str) -> Value {
    json!({
        "journey":"J06","rounds":ROUNDS,"arms":["stock", "candidate", variant],
        "gated_metrics":&METRICS[..3],
        "max_median_ratio_to_stock":MAX_STOCK_RATIO,
        "absolute_limit":"the same measurement's stock median for each gated outcome",
        "stock_durability":"SQLite WAL/NORMAL","native_durability":"omdb Immediate",
        "scope":"selected Linux x64 browser profiles; acknowledgement observed at browser delivery",
        "cpu_rss_qualified":false,"tail_latency_qualified":false,"equal_durability_qualified":false,
    })
}

fn median(mut values: [f64; ROUNDS]) -> f64 {
    values.sort_by(f64::total_cmp);
    values[ROUNDS / 2 - 1] / 2.0 + values[ROUNDS / 2] / 2.0
}

fn judge(input: &str, variant: &str) -> Result<Value> {
    let arms = ["stock", "candidate", variant];
    let mut lines = input.lines();
    if lines.next() != Some(HEADER) {
        return Err("unexpected J06 timing columns".into());
    }
    let mut order = [[None; 3]; ROUNDS];
    let mut samples = [[[0.0; METRICS.len()]; 3]; ROUNDS];
    for line in lines {
        let columns: Vec<_> = line.split('\t').collect();
        if columns.len() != 3 + METRICS.len() {
            return Err("incomplete J06 timing row".into());
        }
        let round = columns[0].parse::<usize>()?;
        let position = columns[1].parse::<usize>()?;
        if !(1..=ROUNDS).contains(&round) || !(1..=arms.len()).contains(&position) {
            return Err("J06 round or arm position out of range".into());
        }
        let arm = arms
            .iter()
            .position(|&name| name == columns[2])
            .ok_or("unknown J06 arm")?;
        let round_order = &mut order[round - 1];
        if round_order.contains(&Some(arm)) || round_order[position - 1].is_some() {
            return Err("duplicate J06 sample in a round".into());
        }
        round_order[position - 1] = Some(arm);
        for (value, column) in samples[round - 1][arm].iter_mut().zip(&columns[3..]) {
            let parsed = column.parse::<f64>()?;
            if !parsed.is_finite() || parsed <= 0.0 {
                return Err("invalid J06 time".into());
            }
            *value = parsed;
        }
    }
    if order.iter().flatten().any(Option::is_none)
        || order.iter().collect::<BTreeSet<_>>().len() != ROUNDS
    {
        return Err("J06 requires all six balanced arm orders".into());
    }
    let mut metrics = serde_json::Map::new();
    let mut failed = Vec::new();
    for (index, name) in METRICS.into_iter().enumerate() {
        let stock = median(samples.map(|round| round[0][index]));
        let control = median(samples.map(|round| round[1][index]));
        let enabled = median(samples.map(|round| round[2][index]));
        let ratio = enabled / stock;
        let control_ratio = enabled / control;
        if !ratio.is_finite() || !control_ratio.is_finite() {
            return Err("invalid J06 comparison ratio".into());
        }
        let gated = index < 3;
        if gated && ratio > MAX_STOCK_RATIO {
            failed.push(name);
        }
        let observation = if variant == BATCH {
            json!({
                "stock_median":stock,"native_control_median":control,"native_batch_median":enabled,
                "batch_to_stock_ratio":ratio,"batch_to_native_control_ratio":control_ratio,
                "gated":gated,
            })
        } else {
            json!({
                "stock_median":stock,"native_control_median":control,"native_variant_median":enabled,
                "variant_to_stock_ratio":ratio,"variant_to_native_control_ratio":control_ratio,
                "gated":gated,
            })
        };
        metrics.insert(name.into(), observation);
    }
    Ok(
        json!({"policy":policy(variant),"passed":failed.is_empty(),"failed_metrics":failed,"metrics":metrics}),
    )
}

fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let (command, variant) = if args.last().is_some_and(|arg| arg == RECEIPTS) {
        (&args[..args.len() - 1], RECEIPTS)
    } else {
        (args.as_slice(), BATCH)
    };
    match command {
        [action] if action == "policy" => println!("{}", policy(variant)),
        [action, path] if action == "judge" => {
            let mut input = String::new();
            File::open(Path::new(path))?
                .take(65_537)
                .read_to_string(&mut input)?;
            if input.len() > 65_536 {
                return Err("J06 timing receipt exceeds bound".into());
            }
            let report = judge(&input, variant)?;
            println!("{report}");
            if report["passed"] != true {
                return Err("J06 median latency exceeds matched stock budget".into());
            }
        }
        _ => return Err("usage: t16-j06-budget (policy | judge J06_TSV) [receipt-reads]".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(variant: &str, enabled_ms: u32) -> String {
        let arms = ["stock", "candidate", variant];
        let mut rows = vec![HEADER.to_owned()];
        for (round, order) in [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ]
        .into_iter()
        .enumerate()
        {
            for (position, arm) in order.into_iter().enumerate() {
                let time = [100, 106, enabled_ms][arm];
                rows.push(format!(
                    "{}\t{}\t{}\t{time}\t{time}\t{time}\t120\t120",
                    round + 1,
                    position + 1,
                    arms[arm]
                ));
            }
        }
        rows.join("\n")
    }

    #[test]
    fn refuses_a_faster_native_variant_that_still_misses_stock() {
        let report = judge(&sample(BATCH, 105), BATCH).unwrap();
        assert_eq!(report["passed"], false);
        assert_eq!(report["failed_metrics"], json!(&METRICS[..3]));
        assert!(
            report["metrics"]["accept_ack_ms"]["batch_to_native_control_ratio"]
                .as_f64()
                .unwrap()
                < 1.0
        );
        assert_eq!(judge(&sample(BATCH, 100), BATCH).unwrap()["passed"], true);
    }

    #[test]
    fn refuses_incomplete_or_nonfinite_observations() {
        let rows = sample(BATCH, 100);
        assert!(judge(rows.rsplit_once('\n').unwrap().0, BATCH).is_err());
        assert!(judge(&rows.replacen("\t100\t", "\tNaN\t", 1), BATCH).is_err());
    }

    #[test]
    fn applies_the_same_stock_budget_to_receipt_reads() {
        let slow = sample(RECEIPTS, 101);
        assert!(judge(&slow, BATCH).is_err());
        assert_eq!(judge(&slow, RECEIPTS).unwrap()["passed"], false);
        assert_eq!(
            judge(&sample(RECEIPTS, 100), RECEIPTS).unwrap()["passed"],
            true
        );
    }
}
