use std::io::{self, Read, Write};
use t3_code_ls_core::project_commands_wire::{
    self, Error, MAX_CODEX_IMPORT_FRAME_BYTES, MAX_FRAME_BYTES,
};

fn run() -> Result<(), Error> {
    let mut args = std::env::args().skip(1);
    let codex_import = match (args.next().as_deref(), args.next()) {
        (None, None) => false,
        (Some("codex-import"), None) => true,
        _ => return Err(Error::InvalidRequest),
    };
    let limit = if codex_import {
        MAX_CODEX_IMPORT_FRAME_BYTES
    } else {
        MAX_FRAME_BYTES
    };
    let mut bytes = Vec::new();
    let mut input = io::stdin().lock();
    let mut chunk = [0u8; 8192];
    loop {
        let count = input.read(&mut chunk).map_err(|_| Error::Io)?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > limit {
            return Err(Error::InputLimit);
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let request = String::from_utf8(bytes).map_err(|_| Error::InvalidRequest)?;
    let response = if codex_import {
        project_commands_wire::respond_codex_import(&request)?
    } else {
        project_commands_wire::respond(&request)?
    };
    let mut output = io::stdout().lock();
    output
        .write_all(response.as_bytes())
        .map_err(|_| Error::Io)?;
    output.flush().map_err(|_| Error::Io)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("t3-code-ls-project: {}", error.message());
        std::process::exit(2);
    }
}
