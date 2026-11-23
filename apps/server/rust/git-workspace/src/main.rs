use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryPaths {
    git_common_dir: String,
    worktree_root: String,
    is_at_repository_root: bool,
    current_branch: Option<String>,
}

fn discover(cwd: &Path) -> Option<RepositoryPaths> {
    if !cwd.is_absolute() {
        return None;
    }
    let cwd = cwd.canonicalize().ok()?;
    let repo = gix::discover_opts(
        &cwd,
        Default::default(),
        gix::open::Options::isolated()
            .strict_config(true)
            .bail_if_untrusted(true),
    )
    .ok()?;
    let snapshot = repo.config_snapshot();
    let config = snapshot.plumbing();
    if config.sections_by_name("include").is_some()
        || config.sections_by_name("includeIf").is_some()
    {
        return None;
    }
    let worktree = repo.workdir()?.canonicalize().ok()?;
    let common_dir = repo.common_dir().canonicalize().ok()?;
    let head = repo.head_name().ok()?;
    let current_branch = match head {
        Some(head) => std::str::from_utf8(head.as_bstr())
            .ok()?
            .strip_prefix("refs/heads/")
            .map(str::to_owned),
        None => None,
    };

    Some(RepositoryPaths {
        git_common_dir: common_dir.to_str()?.to_owned(),
        worktree_root: worktree.to_str()?.to_owned(),
        is_at_repository_root: cwd == worktree,
        current_branch,
    })
}

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(cwd) = args.next().filter(|_| args.next().is_none()) else {
        eprintln!("Usage: t3-code-ls-git-workspace ABSOLUTE_DIRECTORY");
        return ExitCode::from(2);
    };
    let reply = discover(&PathBuf::from(cwd));
    match serde_json::to_writer(std::io::stdout().lock(), &reply) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
