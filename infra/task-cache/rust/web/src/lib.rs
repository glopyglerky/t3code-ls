#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// The binding allocates at most 2,000 input numbers and eight output numbers.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn fold_savings(words: &[f64]) -> Result<Vec<f64>, String> {
    t3_code_ls_task_cache_accounting::fold_savings(words)
        .map(|totals| totals.to_vec())
        .map_err(|_| "Invalid savings tasks".into())
}
