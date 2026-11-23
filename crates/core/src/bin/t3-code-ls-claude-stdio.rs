#[cfg(unix)]
fn main() -> std::process::ExitCode {
    t3_code_ls_core::claude_stdio_helper::run()
}

#[cfg(not(unix))]
fn main() -> std::process::ExitCode {
    println!(r#"{{"type":"error","value":{{"stage":"startup","code":"UnsupportedPlatform"}}}}"#);
    std::process::ExitCode::FAILURE
}
