#![forbid(unsafe_code)]

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod macos;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn main() {
    macos::launch();
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn main() -> std::process::ExitCode {
    eprintln!("The Makepad input candidate requires native arm64 macOS.");
    std::process::ExitCode::FAILURE
}
