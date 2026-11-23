use super::{
    IsolatedTrialPreparation, IsolatedTrialPublication, IsolatedTrialRequest,
    IsolatedTrialSelection, IsolatedTrialVerification, MAX_TRIAL_FILE_BYTES, TrialBackupReceipt,
    TrialFileIdentity, TrialRestoreDirectories, TrialSnapshot, checked_generation, io_error,
    read_trial_receipt, trial_file_digest, trial_file_identity,
    validate_isolated_trial_preparation, validate_isolated_trial_request, verify_restore_snapshot,
    write_trial_receipt,
};
use crate::application::{
    ApplicationTransactions, PreparedServiceActivation, exact_service_version,
};
use crate::application_bootstrap::bootstrap_schema_sha256;
use crate::application_server_ownership::OwnerLock;
use crate::backend::{Backend, path_identity};
use crate::{Error, Result, Store};
use serde::Deserialize;
use std::fs;
use std::io::{self, BufRead, BufReader, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

struct TrialInput {
    path: PathBuf,
    store: Store,
    identity: TrialFileIdentity,
    sha256: String,
}

impl TrialInput {
    async fn open(path: PathBuf, expected: &TrialSnapshot) -> Result<Self> {
        Self::open_with_links(path, expected, 1).await
    }

    async fn open_with_links(
        path: PathBuf,
        expected: &TrialSnapshot,
        expected_links: u64,
    ) -> Result<Self> {
        let store = verify_restore_snapshot(&path, expected).await?;
        let file = store.db.open_verified_offline_file(&path)?;
        let (identity, links) = trial_file_identity(&file)?;
        if links != expected_links {
            return Err(Error::IncompatibleStore);
        }
        Ok(Self {
            path,
            store,
            identity,
            sha256: trial_file_digest(&file)?,
        })
    }

    fn verify(&self) -> Result<()> {
        self.verify_at(&self.path, 1).map(|_| ())
    }

    fn verify_at(&self, path: &Path, expected_links: u64) -> Result<fs::File> {
        let file = self.store.db.open_verified_offline_file(path)?;
        let (identity, links) = trial_file_identity(&file)?;
        if links != expected_links
            || identity != self.identity
            || trial_file_digest(&file)? != self.sha256
        {
            return Err(Error::IncompatibleStore);
        }
        Ok(file)
    }
}

fn disposable_file_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && metadata.nlink() == 1 => Ok(true),
        Ok(_) => Err(Error::IncompatibleStore),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

fn preserved_path(state: &Path, update_id: &str) -> PathBuf {
    state.join(format!(".statev2-source-{update_id}.omdb"))
}

#[derive(Clone, Copy)]
pub(super) enum SealedMove {
    Publish,
    Rollback,
}

struct TrialLease {
    home: PathBuf,
    live: TrialInput,
    source_links: u64,
    checkpoint: TrialInput,
    trial: PathBuf,
    owner: OwnerLock,
    selection_lock: Option<SelectionLock>,
    directories: TrialRestoreDirectories,
}

impl TrialLease {
    async fn open(home: PathBuf, request: &IsolatedTrialRequest) -> Result<Self> {
        Self::open_for(home, request, None).await
    }

    async fn open_for(
        home: PathBuf,
        request: &IsolatedTrialRequest,
        movement: Option<SealedMove>,
    ) -> Result<Self> {
        if !matches!(movement, Some(SealedMove::Rollback))
            && request.target_schema_sha256 != bootstrap_schema_sha256()
        {
            return Err(Error::IncompatibleStore);
        }
        let directories = TrialRestoreDirectories::open(&home)?;
        // The shared selection lease precedes the home and database leases.
        let selection_lock = request
            .activation
            .as_ref()
            .map(|_| SelectionLock::acquire(&directories.runtime))
            .transpose()?;
        let state = TrialRestoreDirectories::pinned(&directories.state);
        let backups = TrialRestoreDirectories::pinned(&directories.backups);
        let owner = OwnerLock::acquire_existing_native(&state.join("server-owner.sqlite"))?;
        let receipt = read_trial_receipt::<TrialBackupReceipt>(
            &backups.join(format!("{}.backup-receipt-v1.json", request.update_id)),
        )?
        .ok_or(Error::IncompatibleStore)?;
        if receipt.database != request.database || receipt.snapshot != request.checkpoint {
            return Err(Error::IncompatibleStore);
        }
        let trial = state.join(format!(".statev2-trial-{}.omdb", request.update_id));
        let preserved = preserved_path(&state, &request.update_id);
        let canonical = state.join("statev2.omdb");
        let (source, source_links) = match movement {
            Some(SealedMove::Publish) if !disposable_file_exists(&trial)? => (preserved, 1),
            Some(SealedMove::Publish) if super::trial_entry_exists(&preserved)? => (canonical, 2),
            Some(SealedMove::Rollback) if super::trial_entry_exists(&preserved)? => (preserved, 1),
            _ => (canonical, 1),
        };
        let live = TrialInput::open_with_links(source, &request.checkpoint, source_links).await?;
        if live.identity != request.database {
            return Err(Error::IncompatibleStore);
        }
        let checkpoint = TrialInput::open(
            backups.join(format!("{}.omdb", request.update_id)),
            &request.checkpoint,
        )
        .await?;
        let lease = Self {
            home,
            live,
            source_links,
            checkpoint,
            trial,
            owner,
            selection_lock,
            directories,
        };
        lease.verify_inputs()?;
        Ok(lease)
    }

    fn verify_inputs(&self) -> Result<()> {
        self.verify_ownership()?;
        self.live.verify_at(&self.live.path, self.source_links)?;
        self.checkpoint.verify()
    }

    fn verify_ownership(&self) -> Result<()> {
        self.directories.verify(&self.home)?;
        if let Some(selection_lock) = &self.selection_lock {
            selection_lock.verify()?;
        }
        self.owner.verify_native()
    }

    async fn verify_candidate(
        &self,
        request: &IsolatedTrialRequest,
        preparation: &IsolatedTrialPreparation,
    ) -> Result<()> {
        let candidate = self
            .open_candidate(self.trial.clone(), request, preparation, 1, true)
            .await?;
        self.verify_activation(request)?;
        self.verify_inputs()?;
        candidate.verify()
    }

    async fn open_candidate(
        &self,
        path: PathBuf,
        request: &IsolatedTrialRequest,
        preparation: &IsolatedTrialPreparation,
        links: u64,
        verify_bootstrap: bool,
    ) -> Result<TrialInput> {
        let candidate = TrialInput::open_with_links(path, &preparation.snapshot, links).await?;
        if candidate.identity != preparation.database || candidate.sha256 != preparation.file_sha256
        {
            return Err(Error::IncompatibleStore);
        }
        if verify_bootstrap {
            candidate.store.verify_bootstrap_schema().await?;
        }
        if ApplicationTransactions::new(candidate.store.clone())
            .prepared_service_activation()
            .await?
            != request.activation
        {
            return Err(Error::IncompatibleStore);
        }
        Ok(candidate)
    }

    fn verify_activation(&self, request: &IsolatedTrialRequest) -> Result<()> {
        if let Some(activation) = &request.activation {
            self.verify_installed_target(activation)?;
            self.pending_selection(
                &request.update_id,
                &activation.from_version,
                &activation.target_version,
                true,
            )?;
        }
        Ok(())
    }

    fn pending_selection(
        &self,
        update_id: &str,
        from: &str,
        target: &str,
        bound: bool,
    ) -> Result<ServiceSelection> {
        let state_path =
            TrialRestoreDirectories::pinned(&self.directories.runtime).join("service-state.json");
        let selection =
            read_trial_receipt::<ServiceSelection>(&state_path)?.ok_or(Error::IncompatibleStore)?;
        let supported_protocol = if bound {
            selection.protocol == 5
        } else {
            matches!(selection.protocol, 3 | 4)
        };
        if !supported_protocol
            || selection.active_version != from
            || selection.update.id != update_id
            || selection.update.from_version != from
            || selection.update.target_version != target
            || selection.update.status != "pending"
            || selection.update.db_path != self.home.join("userdata/statev2.omdb")
            || !exact_service_version(from)
            || !exact_service_version(target)
            || compare_service_versions(target, from) != std::cmp::Ordering::Greater
        {
            return Err(Error::IncompatibleStore);
        }
        Ok(selection)
    }

    fn verify_installed_target(&self, activation: &PreparedServiceActivation) -> Result<()> {
        let version_dir = self
            .home
            .join("runtime/versions")
            .join(&activation.target_version);
        let versions_dir = version_dir.parent().ok_or(Error::IncompatibleStore)?;
        if fs::canonicalize(versions_dir).map_err(io_error)? != versions_dir
            || fs::canonicalize(&version_dir).map_err(io_error)? != version_dir
        {
            return Err(Error::IncompatibleStore);
        }
        let mut options = fs::OpenOptions::new();
        options.read(true);
        let marker = crate::backend::open_regular_file(
            &version_dir.join(".install-complete"),
            &mut options,
        )?;
        let mut content = String::new();
        if marker
            .take(257)
            .read_to_string(&mut content)
            .map_err(io_error)?
            > 256
            || content.trim() != activation.target_version
        {
            return Err(Error::IncompatibleStore);
        }
        let entry = fs::canonicalize(version_dir.join("t3")).map_err(io_error)?;
        if !entry.starts_with(&version_dir) {
            return Err(Error::IncompatibleStore);
        }
        let helper = entry
            .parent()
            .ok_or(Error::IncompatibleStore)?
            .join("native-bin/t3-code-ls-db");
        for (path, sha256) in [
            (&entry, &activation.target_entry_sha256),
            (&helper, &activation.target_helper_sha256),
        ] {
            if fs::canonicalize(path).map_err(io_error)? != *path {
                return Err(Error::IncompatibleStore);
            }
            let file = crate::backend::open_regular_file(path, &mut options)?;
            if trial_file_digest(&file)? != *sha256 {
                return Err(Error::IncompatibleStore);
            }
        }
        self.directories.verify(&self.home)
    }

    fn sync_publication(&self) -> Result<()> {
        self.directories
            .state
            .sync_all()
            .map_err(|_| Error::UnknownCommit)
    }
}

/// Same populated-directory lease used by cloud/serviceSelectionLock.ts.
/// The numeric owner and boot time allow either launcher to recover a dead holder.
struct SelectionLock {
    path: PathBuf,
    directory: fs::File,
    owner: String,
}

impl SelectionLock {
    fn acquire(runtime: &fs::File) -> Result<Self> {
        let runtime = TrialRestoreDirectories::pinned(runtime);
        let path = runtime.join("service-state.json.selection-lock");
        let boot = BufReader::new(fs::File::open("/proc/stat").map_err(io_error)?)
            .lines()
            .find_map(|line| line.ok()?.strip_prefix("btime ")?.parse::<u64>().ok())
            .ok_or(Error::IncompatibleStore)?;
        let candidate = tempfile::Builder::new()
            .prefix(".native-selection-")
            .tempdir_in(&runtime)
            .map_err(io_error)?;
        let token = candidate
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(Error::IncompatibleStore)?;
        let owner = format!("{}.{boot}.{token}", std::process::id());
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(candidate.path().join(&owner))
            .map_err(io_error)?;
        let directory = TrialRestoreDirectories::open_directory(candidate.path())?;
        for attempt in 0..2 {
            match fs::rename(candidate.path(), &path) {
                Ok(()) => {
                    return Ok(Self {
                        path,
                        directory,
                        owner,
                    });
                }
                Err(error)
                    if matches!(error.raw_os_error(), Some(libc::EEXIST | libc::ENOTEMPTY)) =>
                {
                    if attempt > 0 {
                        return Err(Error::WriterBusy);
                    }
                    Self::clear_dead_owner(&path, boot)?;
                }
                Err(error) => return Err(io_error(error)),
            }
        }
        Err(Error::WriterBusy)
    }

    fn clear_dead_owner(path: &Path, boot: u64) -> Result<()> {
        let directory = TrialRestoreDirectories::open_directory(path)?;
        let pinned = TrialRestoreDirectories::pinned(&directory);
        let mut entries = fs::read_dir(&pinned).map_err(io_error)?;
        if let Some(entry) = entries.next() {
            let entry = entry.map_err(io_error)?;
            if entries.next().is_some() || !entry.file_type().map_err(io_error)?.is_file() {
                return Err(Error::IncompatibleStore);
            }
            let name = entry.file_name();
            let name = name.to_str().ok_or(Error::IncompatibleStore)?;
            let mut parts = name.splitn(3, '.');
            let pid = parts
                .next()
                .and_then(|part| part.parse::<u32>().ok())
                .filter(|pid| *pid > 0)
                .ok_or(Error::IncompatibleStore)?;
            let other_boot = parts
                .next()
                .and_then(|part| part.parse::<u64>().ok())
                .ok_or(Error::IncompatibleStore)?;
            if parts.next().is_none_or(str::is_empty) {
                return Err(Error::IncompatibleStore);
            }
            if boot.abs_diff(other_boot) <= 60 {
                match fs::metadata(format!("/proc/{pid}")) {
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    _ => return Err(Error::WriterBusy),
                }
            }
            match fs::remove_file(pinned.join(name)) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(io_error(error)),
            }
        }
        // Rename may replace an empty directory. Leave any new holder intact.
        Ok(())
    }

    fn verify(&self) -> Result<()> {
        let held = self.directory.metadata().map_err(io_error)?;
        let named = fs::symlink_metadata(&self.path).map_err(io_error)?;
        let owner = TrialRestoreDirectories::pinned(&self.directory).join(&self.owner);
        if !named.is_dir()
            || named.dev() != held.dev()
            || named.ino() != held.ino()
            || !fs::symlink_metadata(owner).map_err(io_error)?.is_file()
        {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    }
}

impl Drop for SelectionLock {
    fn drop(&mut self) {
        let owner = TrialRestoreDirectories::pinned(&self.directory).join(&self.owner);
        if fs::remove_file(owner).is_ok() {
            let _ = fs::remove_dir(&self.path);
        }
    }
}

#[cfg(test)]
#[test]
fn native_selection_lock_fences_a_live_owner_and_recovers_an_earlier_boot() {
    let fixture = tempfile::tempdir().unwrap();
    let runtime = TrialRestoreDirectories::open_directory(fixture.path()).unwrap();
    let selected = fixture.path().join("service-state.json.selection-lock");
    let held = SelectionLock::acquire(&runtime).unwrap();
    assert!(matches!(
        SelectionLock::acquire(&runtime),
        Err(Error::WriterBusy)
    ));
    held.verify().unwrap();
    drop(held);
    assert!(!selected.exists());

    fs::create_dir(&selected).unwrap();
    fs::File::create_new(selected.join(format!("{}.0.previous-boot", std::process::id()))).unwrap();
    let recovered = SelectionLock::acquire(&runtime).unwrap();
    recovered.verify().unwrap();
    assert_eq!(fs::read_dir(&selected).unwrap().count(), 1);
    drop(recovered);
    assert_eq!(fs::read_dir(fixture.path()).unwrap().count(), 0);
}

pub(super) async fn verify(
    home: PathBuf,
    request: IsolatedTrialRequest,
    preparation: IsolatedTrialPreparation,
) -> Result<()> {
    let lease = TrialLease::open(home, &request).await?;
    lease.verify_candidate(&request, &preparation).await
}

pub(super) async fn move_sealed(
    home: PathBuf,
    update_id: String,
    movement: SealedMove,
) -> Result<IsolatedTrialPublication> {
    let directories = TrialRestoreDirectories::open(&home)?;
    let receipt = TrialRestoreDirectories::pinned(&directories.state)
        .join(format!(".statev2-trial-{update_id}.receipt-v1.json"));
    let saved = read_trial_receipt::<IsolatedTrialVerification>(&receipt)?
        .ok_or(Error::IncompatibleStore)?;
    let activation = saved
        .request
        .activation
        .as_ref()
        .ok_or(Error::IncompatibleStore)?;
    validate_isolated_trial_request(&home, &update_id, &saved.request)?;
    validate_isolated_trial_preparation(&saved.request, &saved.preparation)?;
    let lease = TrialLease::open_for(home.clone(), &saved.request, Some(movement)).await?;
    directories.verify(&home)?;
    let state = TrialRestoreDirectories::pinned(&lease.directories.state);
    let canonical = state.join("statev2.omdb");
    let original = preserved_path(&state, &update_id);
    let (incoming_path, retained_path, _after_preserve, _after_rename) = match movement {
        SealedMove::Publish => (
            lease.trial.clone(),
            original,
            "isolated-preserved",
            "isolated-renamed",
        ),
        SealedMove::Rollback => {
            if super::trial_entry_exists(&lease.trial)? {
                return Err(Error::IncompatibleStore);
            }
            let failed = state.join(format!(".statev2-failed-sealed-{update_id}.omdb"));
            (
                original,
                failed,
                "isolated-rollback-preserved",
                "isolated-rollback-renamed",
            )
        }
    };
    let reused = !disposable_file_exists(&incoming_path)?;
    let retained_exists = super::trial_entry_exists(&retained_path)?;
    let outgoing_links = if !reused && retained_exists { 2 } else { 1 };
    let (candidate_path, candidate_links) = match movement {
        SealedMove::Publish if reused => (canonical.clone(), 1),
        SealedMove::Publish => (incoming_path.clone(), 1),
        SealedMove::Rollback if reused => (retained_path.clone(), 1),
        SealedMove::Rollback => (canonical.clone(), outgoing_links),
    };
    let candidate = lease
        .open_candidate(
            candidate_path,
            &saved.request,
            &saved.preparation,
            candidate_links,
            matches!(movement, SealedMove::Publish),
        )
        .await?;
    let (outgoing, incoming) = match movement {
        SealedMove::Publish => (&lease.live, &candidate),
        SealedMove::Rollback => (&candidate, &lease.live),
    };
    let verify_binding = || {
        lease.verify_ownership()?;
        match movement {
            SealedMove::Publish => lease.verify_activation(&saved.request)?,
            SealedMove::Rollback => {
                lease.pending_selection(
                    &update_id,
                    &activation.from_version,
                    &activation.target_version,
                    true,
                )?;
            }
        }
        lease.checkpoint.verify()?;
        if read_trial_receipt::<IsolatedTrialVerification>(&receipt)?.as_ref() != Some(&saved) {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    };
    verify_binding()?;
    if !reused {
        let source = outgoing.verify_at(&canonical, outgoing_links)?;
        let staged = incoming.verify_at(&incoming_path, 1)?;
        staged.sync_all().map_err(io_error)?;
        if !retained_exists {
            fs::hard_link(&canonical, &retained_path).map_err(io_error)?;
        }
        source.sync_all().map_err(|_| Error::UnknownCommit)?;
        lease.sync_publication()?;
        #[cfg(test)]
        super::tests::interrupt_trial_publication(_after_preserve);

        verify_binding().map_err(|_| Error::UnknownCommit)?;
        outgoing
            .verify_at(&canonical, 2)
            .map_err(|_| Error::UnknownCommit)?;
        outgoing
            .verify_at(&retained_path, 2)
            .map_err(|_| Error::UnknownCommit)?;
        incoming
            .verify_at(&incoming_path, 1)
            .map_err(|_| Error::UnknownCommit)?;
        // The canonical name carries the selected database and its catalog together.
        fs::rename(&incoming_path, &canonical).map_err(|_| Error::UnknownCommit)?;
        #[cfg(test)]
        super::tests::interrupt_trial_publication(_after_rename);
    }
    lease.sync_publication()?;
    verify_binding().map_err(|_| Error::UnknownCommit)?;
    outgoing
        .verify_at(&retained_path, 1)
        .map_err(|_| Error::UnknownCommit)?;
    incoming
        .verify_at(&canonical, 1)
        .map_err(|_| Error::UnknownCommit)?;
    if disposable_file_exists(&incoming_path).map_err(|_| Error::UnknownCommit)? {
        return Err(Error::UnknownCommit);
    }
    Ok(IsolatedTrialPublication {
        activation: activation.clone(),
        database: incoming.identity.clone(),
        preserved_database: outgoing.identity.clone(),
        reused,
    })
}

// Ported from cloud/serviceProtocol.ts, retained stock 28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f.
fn compare_service_versions(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    fn parts(version: &str) -> (&str, &str) {
        let version = version.split('+').next().unwrap_or_default();
        let (core, prerelease) = version.split_once('-').unwrap_or((version, ""));
        (core, prerelease)
    }
    let (left_core, left_pre) = parts(left);
    let (right_core, right_pre) = parts(right);
    let numeric = |left: &str, right: &str| left.len().cmp(&right.len()).then(left.cmp(right));
    for (left, right) in left_core.split('.').zip(right_core.split('.')) {
        let order = numeric(left, right);
        if order != Ordering::Equal {
            return order;
        }
    }
    if left_pre.is_empty() || right_pre.is_empty() {
        return left_pre.is_empty().cmp(&right_pre.is_empty());
    }
    let mut left = left_pre.split('.');
    let mut right = right_pre.split('.');
    loop {
        let (a, b) = match (left.next(), right.next()) {
            (Some(a), Some(b)) => (a, b),
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
        };
        let a_numeric = a.bytes().all(|byte| byte.is_ascii_digit());
        let b_numeric = b.bytes().all(|byte| byte.is_ascii_digit());
        let order = match (a_numeric, b_numeric) {
            (true, true) => numeric(a, b),
            (false, false) => a.cmp(b),
            _ => b_numeric.cmp(&a_numeric),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
}

#[cfg(test)]
#[test]
fn selection_versions_match_the_launcher_order() {
    use std::cmp::Ordering;
    let ordered = [
        "1.0.0-alpha",
        "1.0.0-alpha.1",
        "1.0.0-alpha.beta",
        "1.0.0-beta",
        "1.0.0-beta.2",
        "1.0.0-beta.11",
        "1.0.0-rc.1",
        "1.0.0",
        "1.1.0",
        "1000000000000000000000000000.0.0",
    ];
    for pair in ordered.windows(2) {
        assert!(pair.iter().all(|version| exact_service_version(version)));
        assert_eq!(compare_service_versions(pair[0], pair[1]), Ordering::Less);
        assert_eq!(
            compare_service_versions(pair[1], pair[0]),
            Ordering::Greater
        );
    }
    assert_eq!(
        compare_service_versions("1.0.0+one", "1.0.0+two"),
        Ordering::Equal
    );
    for invalid in ["01.0.0", "1.0.0-01", "1.0.0\n", "１.0.0", "1.0", "1.0.0-"] {
        assert!(!exact_service_version(invalid));
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingSelection {
    id: String,
    from_version: String,
    target_version: String,
    db_path: PathBuf,
    status: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceSelection {
    protocol: u32,
    active_version: String,
    update: PendingSelection,
}

pub(super) async fn inspect_selection(
    home: PathBuf,
    update_id: String,
    from_version: String,
    target_version: String,
) -> Result<IsolatedTrialSelection> {
    if !exact_service_version(&from_version)
        || !exact_service_version(&target_version)
        || compare_service_versions(&target_version, &from_version) != std::cmp::Ordering::Greater
    {
        return Err(Error::Invalid("invalid service version expectation".into()));
    }
    let directories = TrialRestoreDirectories::open(&home)?;
    let receipt = TrialRestoreDirectories::pinned(&directories.state)
        .join(format!(".statev2-trial-{update_id}.receipt-v1.json"));
    let saved = read_trial_receipt::<IsolatedTrialVerification>(&receipt)?
        .ok_or(Error::IncompatibleStore)?;
    validate_isolated_trial_request(&home, &update_id, &saved.request)?;
    validate_isolated_trial_preparation(&saved.request, &saved.preparation)?;
    let lease = TrialLease::open(home.clone(), &saved.request).await?;
    directories.verify(&home)?;
    let bound = saved.request.activation.is_some();
    let selection = lease.pending_selection(&update_id, &from_version, &target_version, bound)?;
    lease
        .verify_candidate(&saved.request, &saved.preparation)
        .await?;
    if lease.pending_selection(&update_id, &from_version, &target_version, bound)? != selection {
        return Err(Error::IncompatibleStore);
    }
    if read_trial_receipt::<IsolatedTrialVerification>(&receipt)?.as_ref() != Some(&saved) {
        return Err(Error::IncompatibleStore);
    }
    lease.verify_inputs()?;
    Ok(IsolatedTrialSelection {
        update_id,
        from_version,
        target_version,
        source_database: saved.request.database,
        prepared_database: saved.preparation.database,
    })
}

pub(super) async fn prepare(
    home: PathBuf,
    request: IsolatedTrialRequest,
) -> Result<IsolatedTrialPreparation> {
    let lease = TrialLease::open(home, &request).await?;
    lease.verify_activation(&request)?;
    let trial = &lease.trial;
    let receipt = trial.with_extension("receipt-v1.json");
    if let Some(saved) = read_trial_receipt::<IsolatedTrialVerification>(&receipt)? {
        if saved.request != request {
            return Err(Error::IncompatibleStore);
        }
        validate_isolated_trial_preparation(&request, &saved.preparation)?;
        lease.verify_candidate(&request, &saved.preparation).await?;
        lease.sync_publication()?;
        return Ok(saved.preparation);
    }
    let working = trial.with_extension("staging");
    disposable_file_exists(trial)?;
    // Without a receipt, restart from the immutable checkpoint. An interrupted
    // bootstrap may have left a partially changed copy.
    if disposable_file_exists(&working)? {
        fs::remove_file(&working).map_err(io_error)?;
    }
    let (fingerprint, copied) = lease
        .checkpoint
        .store
        .db
        .storage_backup(working.clone())
        .await?;
    if fingerprint.rows != request.checkpoint.rows
        || fingerprint.checksum != request.checkpoint.checksum
    {
        return Err(Error::IncompatibleStore);
    }
    let staged_identity = path_identity(&working)?;
    if staged_identity != copied {
        return Err(Error::IncompatibleStore);
    }
    let candidate = Store {
        db: Backend::open_exclusive_trial(working.clone(), staged_identity).await?,
    };
    if candidate.bootstrap_application().await?.initialized {
        return Err(Error::IncompatibleStore);
    }
    if let Some(activation) = &request.activation {
        ApplicationTransactions::new(candidate.clone())
            .seal_service_trial(activation.clone())
            .await?;
    }
    candidate.shutdown().await?;

    let candidate = Store {
        db: Backend::open_bounded_offline_snapshot(&working, MAX_TRIAL_FILE_BYTES).await?,
    };
    if path_identity(&working)? != copied {
        return Err(Error::IncompatibleStore);
    }
    let generation = checked_generation(&candidate).await?;
    candidate.verify_bootstrap_schema().await?;
    let fingerprint = candidate.db.bounded_storage_fingerprint().await?;
    let file = candidate.db.open_verified_offline_file(&working)?;
    let (database, links) = trial_file_identity(&file)?;
    if links != 1 || database.created.is_none() {
        return Err(Error::IncompatibleStore);
    }
    let file_sha256 = trial_file_digest(&file)?;
    file.sync_all().map_err(io_error)?;

    lease.verify_inputs()?;
    lease.verify_activation(&request)?;
    disposable_file_exists(trial)?;
    candidate.db.verify_identity()?;
    fs::rename(&working, trial).map_err(io_error)?;
    lease.sync_publication()?;
    lease.verify_inputs().map_err(|_| Error::UnknownCommit)?;
    let published = candidate
        .db
        .open_verified_offline_file(trial)
        .map_err(|_| Error::UnknownCommit)?;
    if trial_file_identity(&published).map_err(|_| Error::UnknownCommit)? != (database.clone(), 1) {
        return Err(Error::UnknownCommit);
    }
    let preparation = IsolatedTrialPreparation {
        update_id: request.update_id.clone(),
        database,
        snapshot: TrialSnapshot {
            catalog_sha256: generation.catalog_sha256,
            rows: fingerprint.rows,
            checksum: fingerprint.checksum,
        },
        file_sha256,
        target_schema_sha256: request.target_schema_sha256.clone(),
    };
    let verification = IsolatedTrialVerification {
        request,
        preparation,
    };
    write_trial_receipt(
        &receipt,
        &TrialRestoreDirectories::pinned(&lease.directories.state),
        &verification,
    )?;
    lease.sync_publication()?;
    Ok(verification.preparation)
}
