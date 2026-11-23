//! Diagnostic interval accounting for the existing J02 probe. Wall time only.
use crate::Result;
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn union_ms(intervals: &mut [(f64, f64)]) -> f64 {
    intervals.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut total = 0.0;
    let mut held: Option<(f64, f64)> = None;
    for &(start, end) in intervals.iter() {
        match held {
            Some((left, right)) if start <= right => held = Some((left, right.max(end))),
            Some((left, right)) => {
                total += right - left;
                held = Some((start, end));
            }
            None => held = Some((start, end)),
        }
    }
    total + held.map_or(0.0, |(left, right)| right - left)
}

pub(super) fn summarize(spans: &[Value], descriptor_us: u128) -> Result<Value> {
    let boundary = descriptor_us as f64 / 1000.0;
    if boundary <= 0.0 || spans.len() > 65536 {
        return Err("invalid readiness window or excessive spans".into());
    }
    let mut groups: BTreeMap<&str, Vec<(f64, f64)>> = BTreeMap::new();
    let mut all = Vec::new();
    let mut retained = Vec::new();
    for span in spans {
        let name = span["name"].as_str().ok_or("span has no name")?;
        if !(name.starts_with("server.startup.")
            || name.starts_with("NativeDatabase.")
            || matches!(name, "Omdb.make" | "Sqlite.setup"))
        {
            continue;
        }
        let start = span["start_ms"].as_f64().ok_or("span has no start")?;
        let duration = span["duration_ms"].as_f64().ok_or("span has no duration")?;
        if !start.is_finite() || !duration.is_finite() || duration < 0.0 {
            return Err("invalid readiness span interval".into());
        }
        let left = start.max(0.0);
        let right = (start + duration).min(boundary);
        if right <= left {
            continue;
        }
        groups.entry(name).or_default().push((left, right));
        all.push((left, right));
        retained.push(
            json!({"name": name, "start_ms": start, "duration_ms": duration,
            "clipped_start_ms": left, "clipped_end_ms": right}),
        );
    }
    let rows: Vec<Value> = groups
        .into_iter()
        .map(|(name, mut intervals)| {
            let summed: f64 = intervals.iter().map(|(a, b)| b - a).sum();
            json!({"name": name, "calls": intervals.len(), "summed_held_ms": summed,
            "union_held_ms": union_ms(&mut intervals)})
        })
        .collect();
    let covered = union_ms(&mut all);
    Ok(
        json!({"window_ms": boundary, "rows": rows, "spans": retained,
        "instrumented_union_ms": covered, "unattributed_wall_ms": (boundary - covered).max(0.0),
        "clock": "server epoch timestamps aligned to probe pre-spawn epoch; probe boundaries monotonic",
        "cpu_qualified": false, "causal_critical_path_qualified": false,
        "limits": "Held intervals include scheduling and await time. Names overlap and nest. Unattributed time includes module loading, uninstrumented work, observer polling and clock alignment error. Closed spans only; no physical I/O attribution."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clips_crossing_spans_and_does_not_sum_nested_or_parallel_holds() {
        let spans = vec![
            json!({"name":"Omdb.make", "start_ms":2.0, "duration_ms":12.0}),
            json!({"name":"NativeDatabase.send", "start_ms":3.0, "duration_ms":3.0}),
            json!({"name":"NativeDatabase.send", "start_ms":5.0, "duration_ms":3.0}),
            json!({"name":"server.startup.http.wait", "start_ms":9.0, "duration_ms":5.0}),
            json!({"name":"server.startup.ready.publish", "start_ms":11.0, "duration_ms":2.0}),
            json!({"name":"unrelated", "start_ms":0.0, "duration_ms":10.0}),
        ];
        let result = summarize(&spans, 10_000).unwrap();
        assert_eq!(result["instrumented_union_ms"], 8.0);
        assert_eq!(result["unattributed_wall_ms"], 2.0);
        let send = result["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == "NativeDatabase.send")
            .unwrap();
        assert_eq!(send["summed_held_ms"], 6.0);
        assert_eq!(send["union_held_ms"], 5.0);
        assert_eq!(result["spans"].as_array().unwrap().len(), 4);
    }
    #[test]
    fn empty_is_unattributed_and_negative_duration_fails() {
        assert_eq!(
            summarize(&[], 10_000).unwrap()["unattributed_wall_ms"],
            10.0
        );
        assert!(
            summarize(
                &[json!({"name":"Omdb.make", "start_ms":0.0,
            "duration_ms":-1.0})],
                1000
            )
            .is_err()
        );
    }
}
