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

fn open_repository(cwd: &Path) -> Option<(PathBuf, gix::Repository)> {
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
    repo.workdir()?;
    Some((cwd, repo))
}

fn discover(cwd: &Path) -> Option<RepositoryPaths> {
    let (cwd, repo) = open_repository(cwd)?;
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

fn has_remote_ref(cwd: &Path, name: &str) -> Option<bool> {
    if !name.starts_with("refs/remotes/") {
        return None;
    }
    let (_, repo) = open_repository(cwd)?;
    let Some(mut reference) = repo.try_find_reference(name).ok()? else {
        return Some(false);
    };
    // The resolver also accepts abbreviated names. Only the requested ref counts.
    if std::str::from_utf8(reference.name().as_bstr()).ok()? != name {
        return Some(false);
    }
    let id = reference.follow_to_object().ok()?;
    let header = repo.try_find_header(id).ok()??;
    (header.kind() == gix::objs::Kind::Commit).then_some(true)
}

fn reply(value: impl Serialize) -> ExitCode {
    match serde_json::to_writer(std::io::stdout().lock(), &value) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

fn main() -> ExitCode {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [cwd] => reply(discover(Path::new(cwd))),
        [operation, cwd, name] if operation == "has-remote-ref" => reply(
            name.to_str()
                .and_then(|name| has_remote_ref(Path::new(cwd), name)),
        ),
        _ => {
            eprintln!("Usage: t3-code-ls-git-workspace [has-remote-ref] ABSOLUTE_DIRECTORY [REF]");
            ExitCode::from(2)
        }
    }
}
