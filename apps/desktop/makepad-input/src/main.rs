#![forbid(unsafe_code)]

#[path = "../../../../packages/client-runtime/rust/host/server_snapshot.rs"]
mod server_snapshot;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
static SNAPSHOT: std::sync::OnceLock<Result<server_snapshot::Snapshot, &'static str>> =
    std::sync::OnceLock::new();

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
static HISTORY: std::sync::OnceLock<
    std::sync::Mutex<Option<Result<server_snapshot::History, &'static str>>>,
> = std::sync::OnceLock::new();

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod macos;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn main() -> std::process::ExitCode {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    match arguments.as_slice() {
        [] => {}
        [argument] if argument == "--proof" => {}
        [argument] if argument == "--thread-snapshot" || argument == "--thread-snapshot-proof" => {
            let result = server_snapshot::Connection::read(std::io::stdin().lock())
                .and_then(|connection| connection.snapshot());
            let _ = SNAPSHOT.set(result);
        }
        [argument] if argument == "--thread-history" || argument == "--thread-history-proof" => {
            let result = server_snapshot::Connection::read(std::io::stdin().lock())
                .and_then(server_snapshot::Connection::history);
            let _ = HISTORY.set(std::sync::Mutex::new(Some(result)));
        }
        _ => {
            eprintln!(
                "Usage: t3-code-ls-makepad-input [--proof | --thread-snapshot | --thread-snapshot-proof | --thread-history | --thread-history-proof] < CONNECTION_JSON"
            );
            return std::process::ExitCode::from(2);
        }
    }
    macos::launch();
    std::process::ExitCode::SUCCESS
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn main() -> std::process::ExitCode {
    eprintln!("The Makepad input candidate requires native arm64 macOS.");
    std::process::ExitCode::FAILURE
}
