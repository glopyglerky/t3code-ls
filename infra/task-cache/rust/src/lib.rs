#![no_std]
#![forbid(unsafe_code)]

//! Savings policy from infra/task-cache/src/Savings.ts at stock
//! 28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f, licensed MIT.
//! The host retains validation of summary identity and atomic receipt insertion.

pub const MAX_TASKS: usize = 1000;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidTasks;

/// Fold source/millisecond pairs into the existing D1 bind order.
/// Source codes are local=0, remote=1, unspecified=2, executed=3, failed=4.
/// Output is local_ms, remote_ms, local_hits, remote_hits, executed,
/// restore_failures, unspecified_ms, unspecified_hits.
/// Each source's additions retain input order and JavaScript binary64 rounding.
pub fn fold_savings(words: &[f64]) -> Result<[f64; 8], InvalidTasks> {
    if words.len() % 2 != 0 || words.len() / 2 > MAX_TASKS {
        return Err(InvalidTasks);
    }
    let mut totals = [0.0; 8];
    for pair in words.chunks_exact(2) {
        let source = pair[0];
        let saved_ms = pair[1];
        if !saved_ms.is_finite()
            || !(0.0..=MAX_SAFE_INTEGER).contains(&saved_ms)
            || saved_ms % 1.0 != 0.0
        {
            return Err(InvalidTasks);
        }
        match source {
            0.0 => {
                totals[0] += saved_ms;
                totals[2] += 1.0;
            }
            1.0 => {
                totals[1] += saved_ms;
                totals[3] += 1.0;
            }
            2.0 => {
                totals[6] += saved_ms;
                totals[7] += 1.0;
            }
            3.0 => totals[4] += 1.0,
            4.0 => totals[5] += 1.0,
            _ => return Err(InvalidTasks),
        }
    }
    Ok(totals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_sources_preserve_binary64_addition_order() {
        assert_eq!(fold_savings(&[]), Ok([0.0; 8]));
        let words = [
            0.0,
            MAX_SAFE_INTEGER,
            1.0,
            12.0,
            0.0,
            2.0,
            2.0,
            7.0,
            0.0,
            1.0,
            3.0,
            100.0,
            4.0,
            200.0,
            2.0,
            3.0,
        ];
        assert_eq!(
            fold_savings(&words),
            Ok([9_007_199_254_740_992.0, 12.0, 3.0, 1.0, 1.0, 1.0, 10.0, 2.0])
        );
    }

    #[test]
    fn malformed_or_excessive_tasks_are_rejected() {
        for words in [
            &[0.0][..],
            &[5.0, 0.0],
            &[f64::NAN, 0.0],
            &[0.0, f64::NAN],
            &[0.0, f64::INFINITY],
            &[0.0, -1.0],
            &[0.0, 0.5],
            &[0.0, MAX_SAFE_INTEGER + 1.0],
        ] {
            assert_eq!(fold_savings(words), Err(InvalidTasks));
        }
        assert_eq!(fold_savings(&[0.0; MAX_TASKS * 2 + 2]), Err(InvalidTasks));
        assert_eq!(fold_savings(&[0.0; MAX_TASKS * 2]).unwrap()[2], 1000.0);
    }
}
