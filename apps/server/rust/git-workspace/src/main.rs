use serde::Serialize;
use std::path::{Component, Path, PathBuf};
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
    if let Some(configured) = repo.config_snapshot().string("core.worktree") {
        let configured = gix::path::from_bstring(configured).ok()?;
        // gix can collapse `..` before following a symlink in core.worktree.
        if configured
            .components()
            .any(|part| part == Component::ParentDir)
            && repo.git_dir().join(configured).canonicalize().ok()? != worktree
        {
            return None;
        }
    }
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

fn has_branch_ref(cwd: &Path, name: &str, namespace: &str) -> Option<bool> {
    if !name.starts_with(namespace) {
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

fn local_branch_names(cwd: &Path) -> Option<Vec<String>> {
    const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
    let (_, repo) = open_repository(cwd)?;
    let references = repo.references().ok()?;
    let mut names = Vec::new();
    let mut bytes = 0usize;
    for reference in references.local_branches().ok()? {
        let reference = reference.ok()?;
        // Symbolic branches require Git's own resolution and diagnostics.
        let id = reference.try_id()?;
        repo.try_find_header(id).ok()??;
        let name = std::str::from_utf8(reference.name().as_bstr())
            .ok()?
            .strip_prefix("refs/heads/")?;
        bytes = bytes.checked_add(name.len() + 1)?;
        if bytes > MAX_OUTPUT_BYTES {
            return None;
        }
        names.push(name.to_owned());
    }
    // for-each-ref's default order compares complete ref names bytewise.
    names.sort_unstable();
    (serde_json::to_vec(&names).ok()?.len() <= MAX_OUTPUT_BYTES).then_some(names)
}

// Only the ordinary, born local-branch case is admitted. Git owns all other
// HEAD diagnostics, including ambiguous pseudoref names and symbolic branches.
fn branch_head(cwd: &Path) -> Option<String> {
    discover(cwd)?;
    let (_, repo) = open_repository(cwd)?;
    for name in [
        "refs/HEAD",
        "refs/tags/HEAD",
        "refs/heads/HEAD",
        "refs/remotes/HEAD",
        "refs/remotes/HEAD/HEAD",
    ] {
        if repo.try_find_reference(name).ok()?.is_some() {
            return None;
        }
    }
    let head = repo.head_name().ok()??;
    let name = std::str::from_utf8(head.as_bstr()).ok()?;
    name.strip_prefix("refs/heads/")?;
    let reference = repo.try_find_reference(name).ok()??;
    let id = reference.try_id()?;
    let header = repo.try_find_header(id).ok()??;
    (header.kind() == gix::objs::Kind::Commit).then(|| name.to_owned())
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
        [operation, cwd] if operation == "branch-head" => reply(branch_head(Path::new(cwd))),
        [operation, cwd] if operation == "local-branch-names" => {
            reply(local_branch_names(Path::new(cwd)))
        }
        [operation, cwd, name] if operation == "has-remote-ref" => reply(
            name.to_str()
                .and_then(|name| has_branch_ref(Path::new(cwd), name, "refs/remotes/")),
        ),
        [operation, cwd, name] if operation == "has-local-ref" => reply(
            name.to_str()
                .and_then(|name| has_branch_ref(Path::new(cwd), name, "refs/heads/")),
        ),
        _ => {
            eprintln!(
                "Usage: t3-code-ls-git-workspace [has-remote-ref|has-local-ref|local-branch-names|branch-head] ABSOLUTE_DIRECTORY [REF]"
            );
            ExitCode::from(2)
        }
    }
}
