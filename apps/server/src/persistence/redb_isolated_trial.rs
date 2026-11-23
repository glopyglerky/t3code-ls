use super::{
    CandidatePreparationObservation, NativePromotionIntent, SealedPromotionPhase,
    SealedPromotionPublication,
};
use super::{
    IsolatedTrialPreparation, IsolatedTrialPublication, IsolatedTrialRequest,
    IsolatedTrialSelection, IsolatedTrialVerification, MAX_TRIAL_FILE_BYTES, TrialBackupReceipt,
    TrialFileIdentity, TrialRestoreDirectories, TrialSnapshot, checked_generation, io_error,
    read_trial_file, read_trial_receipt, trial_document_sha256, trial_executable_digest,
    trial_file_digest, trial_file_identity, validate_isolated_trial_preparation,
    validate_isolated_trial_request, verify_restore_snapshot, write_trial_receipt,
};
use crate::application::{
    ApplicationTransactions, PreparedServiceActivation, exact_service_version,
};
use crate::application_bootstrap::bootstrap_schema_sha256;
use crate::application_server_ownership::OwnerLock;
use crate::backend::{Backend, path_identity};
use crate::{Error, Result, Store};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::io::{self, BufRead, BufReader, Read};
use std::os::fd::AsRawFd;
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
    PublishIntended,
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
            Some(SealedMove::Publish | SealedMove::PublishIntended)
                if !disposable_file_exists(&trial)? =>
            {
                (preserved, 1)
            }
            Some(SealedMove::Publish | SealedMove::PublishIntended)
                if super::trial_entry_exists(&preserved)? =>
            {
                (canonical, 2)
            }
            Some(SealedMove::Rollback) if disposable_file_exists(&trial)? => {
                let links = if super::trial_entry_exists(&preserved)? {
                    2
                } else {
                    1
                };
                (canonical, links)
            }
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
        if !selection.is_pending_for(&self.home, update_id, from, target, bound) {
            return Err(Error::IncompatibleStore);
        }
        Ok(selection)
    }

    fn verify_installed_target(&self, activation: &PreparedServiceActivation) -> Result<()> {
        self.verify_installed_runtime(
            &activation.target_version,
            &activation.target_entry_sha256,
            &activation.target_helper_sha256,
        )
        .map(|_| ())
    }

    fn verify_installed_runtime(
        &self,
        version: &str,
        entry_sha256: &str,
        helper_sha256: &str,
    ) -> Result<PathBuf> {
        let version_dir = self.home.join("runtime/versions").join(version);
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
            || content.trim() != version
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
        for (path, sha256, executable) in [
            (&entry, entry_sha256, true),
            (&helper, helper_sha256, false),
        ] {
            if fs::canonicalize(path).map_err(io_error)? != *path {
                return Err(Error::IncompatibleStore);
            }
            let file = crate::backend::open_regular_file(path, &mut options)?;
            let digest = if executable {
                trial_executable_digest(&file)?
            } else {
                trial_file_digest(&file)?
            };
            if digest != sha256 {
                return Err(Error::IncompatibleStore);
            }
        }
        self.directories.verify(&self.home)?;
        Ok(helper)
    }

    async fn verify_promotion_bindings(&self, saved: &IsolatedTrialVerification) -> Result<()> {
        if let Some(activation) = self.verify_promotion_runtimes(saved).await? {
            self.pending_selection(
                &activation.update_id,
                &activation.from_version,
                &activation.target_version,
                true,
            )?;
        }
        Ok(())
    }

    async fn verify_promotion_runtimes<'a>(
        &self,
        saved: &'a IsolatedTrialVerification,
    ) -> Result<Option<&'a PreparedServiceActivation>> {
        let Some(intent) = &saved.promotion_intent else {
            return Ok(None);
        };
        let activation = saved
            .request
            .activation
            .as_ref()
            .ok_or(Error::IncompatibleStore)?;
        let source = self.verify_installed_runtime(
            &activation.from_version,
            &intent.source_entry_sha256,
            &intent.source_helper_sha256,
        )?;
        let target = self.verify_installed_runtime(
            &activation.target_version,
            &activation.target_entry_sha256,
            &activation.target_helper_sha256,
        )?;
        for version in [&activation.from_version, &activation.target_version] {
            let entry = self.home.join("runtime/versions").join(version).join("t3");
            if fs::metadata(entry).map_err(io_error)?.mode() & 0o111 == 0 {
                return Err(Error::IncompatibleStore);
            }
        }
        let publication = saved.sealed_publication.as_ref().map(|sealed| sealed.phase);
        let forward = publication == Some(SealedPromotionPhase::ForwardCommitted);
        verify_intent_helper(
            &source,
            &intent.source_helper_schema_sha256,
            publication.is_some(),
            forward.then_some(intent.source_helper_sha256.as_str()),
        )
        .await?;
        verify_intent_helper(
            &target,
            &activation.target_schema_sha256,
            publication.is_some(),
            forward.then_some(activation.target_helper_sha256.as_str()),
        )
        .await?;
        self.verify_installed_runtime(
            &activation.from_version,
            &intent.source_entry_sha256,
            &intent.source_helper_sha256,
        )?;
        self.verify_installed_target(activation)?;
        Ok(Some(activation))
    }

    fn selection_digest(&self) -> Result<String> {
        let path =
            TrialRestoreDirectories::pinned(&self.directories.runtime).join("service-state.json");
        let bytes = read_trial_file(&path)?.ok_or(Error::IncompatibleStore)?;
        Ok(trial_document_sha256(&bytes))
    }

    fn verify_sealed_binding(&self, saved: &IsolatedTrialVerification) -> Result<()> {
        let Some(publication) = &saved.sealed_publication else {
            return Ok(());
        };
        if self.selection_digest()? != publication.selection_sha256 {
            return Err(Error::IncompatibleStore);
        }
        let activation = saved
            .request
            .activation
            .as_ref()
            .ok_or(Error::IncompatibleStore)?;
        let intent = saved
            .promotion_intent
            .as_ref()
            .ok_or(Error::IncompatibleStore)?;
        self.verify_installed_runtime(
            &activation.from_version,
            &intent.source_entry_sha256,
            &intent.source_helper_sha256,
        )?;
        self.verify_installed_target(activation)
    }

    #[cfg(test)]
    fn verify_published_layout(&self, update_id: &str) -> Result<()> {
        let state = TrialRestoreDirectories::pinned(&self.directories.state);
        let failed = state.join(format!(".statev2-failed-sealed-{update_id}.omdb"));
        if super::trial_entry_exists(&self.trial)? || super::trial_entry_exists(&failed)? {
            return Err(Error::IncompatibleStore);
        }
        self.live.verify_at(&preserved_path(&state, update_id), 1)?;
        Ok(())
    }

    #[cfg(test)]
    fn verify_published_candidate(&self, update_id: &str, candidate: &TrialInput) -> Result<()> {
        self.verify_published_layout(update_id)?;
        candidate.verify()
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
    let receipt = lease.trial.with_extension("receipt-v1.json");
    let saved = read_trial_receipt::<IsolatedTrialVerification>(&receipt)?
        .ok_or(Error::IncompatibleStore)?;
    validate_observation(&saved)?;
    if saved.request != request || saved.preparation != preparation {
        return Err(Error::IncompatibleStore);
    }
    lease.verify_candidate(&request, &preparation).await?;
    lease.verify_promotion_bindings(&saved).await
}

async fn record_sealed_phase(
    lease: &TrialLease,
    receipt: &Path,
    saved: &mut IsolatedTrialVerification,
    phase: SealedPromotionPhase,
) -> Result<()> {
    let mut proposed = saved.clone();
    let selection_sha256 = lease.selection_digest()?;
    if let Some(publication) = &proposed.sealed_publication {
        if publication.selection_sha256 != selection_sha256 {
            return Err(Error::IncompatibleStore);
        }
        if publication.phase == phase {
            return Ok(());
        }
        if !matches!(
            (publication.phase, phase),
            (
                SealedPromotionPhase::Publishing,
                SealedPromotionPhase::Published | SealedPromotionPhase::RollingBack
            ) | (
                SealedPromotionPhase::Published,
                SealedPromotionPhase::RollingBack
            ) | (
                SealedPromotionPhase::RollingBack,
                SealedPromotionPhase::RolledBack
            )
        ) {
            return Err(Error::IncompatibleStore);
        }
    } else if !matches!(
        phase,
        SealedPromotionPhase::Publishing | SealedPromotionPhase::RollingBack
    ) {
        return Err(Error::IncompatibleStore);
    }
    proposed.sealed_publication = Some(SealedPromotionPublication {
        version: 1,
        selection_sha256,
        phase,
    });
    validate_observation(&proposed)?;
    lease.verify_promotion_bindings(&proposed).await?;
    lease.verify_sealed_binding(&proposed)?;
    persist_sealed_receipt(lease, receipt, saved, &proposed, || Ok(()))?;
    *saved = proposed;
    Ok(())
}

fn persist_sealed_receipt(
    lease: &TrialLease,
    receipt: &Path,
    saved: &IsolatedTrialVerification,
    proposed: &IsolatedTrialVerification,
    verify_files: impl FnOnce() -> Result<()>,
) -> Result<()> {
    #[cfg(test)]
    let phase = proposed.sealed_publication.as_ref().unwrap().phase;
    let bytes = serde_json::to_vec(proposed).map_err(|_| Error::IncompatibleStore)?;
    if bytes.len() > 8192 {
        return Err(Error::IncompatibleStore);
    }
    #[cfg(test)]
    if phase == SealedPromotionPhase::ForwardCommitted {
        super::tests::interrupt_trial_publication("forward-commit-prewrite");
    }
    let mut stage =
        tempfile::NamedTempFile::new_in(TrialRestoreDirectories::pinned(&lease.directories.state))
            .map_err(io_error)?;
    stage.write_all(&bytes).map_err(io_error)?;
    stage.as_file().sync_all().map_err(io_error)?;
    verify_files()?;
    lease.verify_ownership()?;
    lease.checkpoint.verify()?;
    lease.verify_sealed_binding(proposed)?;
    if read_trial_receipt::<IsolatedTrialVerification>(receipt)?.as_ref() != Some(saved) {
        return Err(Error::IncompatibleStore);
    }
    #[cfg(test)]
    if phase == SealedPromotionPhase::Publishing {
        super::tests::interrupt_trial_publication("sealed-phase-publishing-written");
    }
    stage
        .persist(receipt)
        .map_err(|error| io_error(error.error))?;
    lease.sync_publication()?;
    if read_trial_receipt::<IsolatedTrialVerification>(receipt)?.as_ref() != Some(proposed) {
        return Err(Error::UnknownCommit);
    }
    #[cfg(test)]
    super::tests::interrupt_trial_publication(match phase {
        SealedPromotionPhase::Publishing => "sealed-phase-publishing-durable",
        SealedPromotionPhase::Published => "sealed-phase-published-durable",
        SealedPromotionPhase::RollingBack => "sealed-phase-rolling-back-durable",
        SealedPromotionPhase::RolledBack => "sealed-phase-rolled-back-durable",
        SealedPromotionPhase::ForwardCommitted => "forward-commit-durable",
    });
    Ok(())
}

#[cfg(test)]
pub(super) async fn record_forward_commit(home: PathBuf, update_id: String) -> Result<bool> {
    let directories = TrialRestoreDirectories::open(&home)?;
    let receipt = TrialRestoreDirectories::pinned(&directories.state)
        .join(format!(".statev2-trial-{update_id}.receipt-v1.json"));
    let saved = read_trial_receipt::<IsolatedTrialVerification>(&receipt)?
        .ok_or(Error::IncompatibleStore)?;
    validate_observation(&saved)?;
    validate_isolated_trial_request(&home, &update_id, &saved.request)?;
    validate_isolated_trial_preparation(&saved.request, &saved.preparation)?;
    let publication = saved
        .sealed_publication
        .as_ref()
        .ok_or(Error::IncompatibleStore)?;
    let reused = match publication.phase {
        SealedPromotionPhase::Published => false,
        SealedPromotionPhase::ForwardCommitted => true,
        _ => return Err(Error::IncompatibleStore),
    };

    let lease = TrialLease::open_for(
        home.clone(),
        &saved.request,
        Some(SealedMove::PublishIntended),
    )
    .await?;
    directories.verify(&home)?;
    if read_trial_receipt::<IsolatedTrialVerification>(&receipt)?.as_ref() != Some(&saved) {
        return Err(Error::IncompatibleStore);
    }
    let state = TrialRestoreDirectories::pinned(&lease.directories.state);
    let candidate = lease
        .open_candidate(
            state.join("statev2.omdb"),
            &saved.request,
            &saved.preparation,
            1,
            true,
        )
        .await?;
    let verify_files = || lease.verify_published_candidate(&update_id, &candidate);

    let mut proposed = saved.clone();
    proposed.sealed_publication = Some(SealedPromotionPublication {
        phase: SealedPromotionPhase::ForwardCommitted,
        ..publication.clone()
    });
    lease.verify_sealed_binding(&saved)?;
    lease.verify_promotion_bindings(&proposed).await?;
    if reused {
        lease.sync_publication()?;
        lease.verify_inputs()?;
        verify_files()?;
        lease.verify_sealed_binding(&saved)?;
        if read_trial_receipt::<IsolatedTrialVerification>(&receipt)?.as_ref() != Some(&saved) {
            return Err(Error::IncompatibleStore);
        }
    } else {
        persist_sealed_receipt(&lease, &receipt, &saved, &proposed, verify_files)?;
    }
    Ok(reused)
}

#[cfg(test)]
pub(super) async fn record_forward_selection(home: PathBuf, update_id: String) -> Result<bool> {
    let directories = TrialRestoreDirectories::open(&home)?;
    let receipt = TrialRestoreDirectories::pinned(&directories.state)
        .join(format!(".statev2-trial-{update_id}.receipt-v1.json"));
    let receipt_bytes = read_trial_file(&receipt)?.ok_or(Error::IncompatibleStore)?;
    let saved: IsolatedTrialVerification =
        serde_json::from_slice(&receipt_bytes).map_err(|_| Error::IncompatibleStore)?;
    validate_observation(&saved)?;
    validate_isolated_trial_request(&home, &update_id, &saved.request)?;
    validate_isolated_trial_preparation(&saved.request, &saved.preparation)?;
    let publication = saved
        .sealed_publication
        .as_ref()
        .filter(|publication| publication.phase == SealedPromotionPhase::ForwardCommitted)
        .ok_or(Error::IncompatibleStore)?;
    if serde_json::to_vec(&saved).map_err(|_| Error::IncompatibleStore)? != receipt_bytes {
        return Err(Error::IncompatibleStore);
    }

    let lease = TrialLease::open_for(
        home.clone(),
        &saved.request,
        Some(SealedMove::PublishIntended),
    )
    .await?;
    directories.verify(&home)?;
    let state = TrialRestoreDirectories::pinned(&lease.directories.state);
    let candidate = lease
        .open_candidate(
            state.join("statev2.omdb"),
            &saved.request,
            &saved.preparation,
            1,
            true,
        )
        .await?;
    let activation = lease
        .verify_promotion_runtimes(&saved)
        .await?
        .ok_or(Error::IncompatibleStore)?;
    let runtime = &lease.directories.runtime;
    let selection = TrialRestoreDirectories::pinned(runtime).join("service-state.json");
    let current = read_trial_file(&selection)?.ok_or(Error::IncompatibleStore)?;
    let proposed = forward_selection_bytes(&home, activation, &receipt_bytes)?;
    if current != proposed {
        let pending: ServiceSelection =
            serde_json::from_slice(&current).map_err(|_| Error::IncompatibleStore)?;
        if !pending.is_pending_for(
            &home,
            &update_id,
            &activation.from_version,
            &activation.target_version,
            true,
        ) || trial_document_sha256(&current) != publication.selection_sha256
        {
            return Err(Error::IncompatibleStore);
        }
    }
    persist_forward_selection(runtime, &selection, &current, &proposed, || {
        lease.verify_ownership()?;
        lease.checkpoint.verify()?;
        lease.verify_published_candidate(&update_id, &candidate)?;
        // Order the durable receipt before the selection, including on a crash retry.
        lease.sync_publication()?;
        if read_trial_file(&receipt)?.as_deref() != Some(receipt_bytes.as_slice()) {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    })
}

#[cfg(test)]
fn forward_selection_bytes(
    home: &Path,
    activation: &PreparedServiceActivation,
    receipt: &[u8],
) -> Result<Vec<u8>> {
    // Older installers honor the pending status even though their launchers
    // reject the forward-only shape.
    let bytes = serde_json::to_vec(&serde_json::json!({
        "protocol": 5,
        "phase": "forward-selected",
        "activeVersion": activation.target_version,
        "forwardReceiptSha256": trial_document_sha256(receipt),
        "update": {
            "id": activation.update_id,
            "fromVersion": activation.from_version,
            "targetVersion": activation.target_version,
            "dbPath": home.join("userdata/statev2.omdb"),
            "status": "pending",
        }
    }))
    .map_err(|_| Error::IncompatibleStore)?;
    if bytes.len() > super::MAX_TRIAL_RECEIPT_BYTES {
        return Err(Error::IncompatibleStore);
    }
    Ok(bytes)
}

#[cfg(test)]
pub(super) async fn record_forward_catalog(home: PathBuf, update_id: String) -> Result<bool> {
    use super::tests::interrupt_trial_publication;
    use crate::{application::ForwardServiceActivation, backend::ExclusiveTrialFile};

    let directories = TrialRestoreDirectories::open(&home)?;
    let receipt = TrialRestoreDirectories::pinned(&directories.state)
        .join(format!(".statev2-trial-{update_id}.receipt-v1.json"));
    let receipt_bytes = read_trial_file(&receipt)?.ok_or(Error::IncompatibleStore)?;
    let saved: IsolatedTrialVerification =
        serde_json::from_slice(&receipt_bytes).map_err(|_| Error::IncompatibleStore)?;
    validate_observation(&saved)?;
    validate_isolated_trial_request(&home, &update_id, &saved.request)?;
    validate_isolated_trial_preparation(&saved.request, &saved.preparation)?;
    if saved.sealed_publication.as_ref().map(|record| record.phase)
        != Some(SealedPromotionPhase::ForwardCommitted)
        || serde_json::to_vec(&saved).map_err(|_| Error::IncompatibleStore)? != receipt_bytes
    {
        return Err(Error::IncompatibleStore);
    }

    let lease =
        TrialLease::open_for(home, &saved.request, Some(SealedMove::PublishIntended)).await?;
    directories.verify(&lease.home)?;
    let state = TrialRestoreDirectories::pinned(&lease.directories.state);
    let candidate = ExclusiveTrialFile::acquire(state.join("statev2.omdb"), MAX_TRIAL_FILE_BYTES)?;
    let activation = lease
        .verify_promotion_runtimes(&saved)
        .await?
        .ok_or(Error::IncompatibleStore)?;
    let runtime = &lease.directories.runtime;
    let selection = TrialRestoreDirectories::pinned(runtime).join("service-state.json");
    let selected = forward_selection_bytes(&lease.home, activation, &receipt_bytes)?;
    let marker = ForwardServiceActivation {
        update_id: update_id.clone(),
        forward_selection_sha256: trial_document_sha256(&selected),
    };
    let verify = || {
        lease.verify_ownership()?;
        lease.checkpoint.verify()?;
        lease.verify_published_layout(&update_id)?;
        if trial_file_identity(&candidate.verified_file()?)?
            != (saved.preparation.database.clone(), 1)
            || read_trial_file(&receipt)?.as_deref() != Some(receipt_bytes.as_slice())
            || read_trial_file(&selection)?.as_deref() != Some(selected.as_slice())
        {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    };
    verify()?;
    lease.sync_publication()?;
    runtime.sync_all().map_err(|_| Error::UnknownCommit)?;

    // A writable open can change the raw bytes even without an application
    // commit. Record that the exact prepared image passed before that open.
    let witness = state.join(format!(".statev2-forward-{update_id}.json"));
    let witness_bytes = serde_json::to_vec(&marker).map_err(|_| Error::IncompatibleStore)?;
    let armed = match read_trial_file(&witness)? {
        None => false,
        Some(bytes) if bytes == witness_bytes => true,
        Some(_) => return Err(Error::IncompatibleStore),
    };
    let verify_witness = || {
        verify()?;
        if read_trial_file(&witness)?.as_deref() != Some(witness_bytes.as_slice()) {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    };
    let digest = trial_file_digest(&candidate.verified_file()?)?;
    if !armed && digest != saved.preparation.file_sha256 {
        return Err(Error::IncompatibleStore);
    }
    let (db, recovery) = match candidate.snapshot().await {
        Ok(db) => (db, false),
        Err(Error::RecoveryRequired) if armed => {
            (candidate.recover_copy(state.clone()).await?, true)
        }
        Err(error) => return Err(error),
    };
    let snapshot = Store { db };
    snapshot.verify_bootstrap_schema().await?;
    let reused = ApplicationTransactions::new(snapshot.clone())
        .verify_forward_catalog(activation, &marker, &saved.preparation.snapshot)
        .await?;
    snapshot.shutdown().await?;
    verify()?;
    if trial_file_digest(&candidate.verified_file()?)? != digest || (reused && !armed) {
        return Err(Error::IncompatibleStore);
    }
    if reused && !recovery {
        verify_witness()?;
        return Ok(true);
    }
    if !armed {
        write_trial_receipt(&witness, &state, &marker)?;
    }
    lease.sync_publication()?;
    verify_witness()?;
    interrupt_trial_publication("forward-catalog-armed");
    let store = Store {
        db: candidate
            .open_checked_writer(move |file| {
                if trial_file_digest(file)? != digest {
                    return Err(Error::IncompatibleStore);
                }
                Ok(())
            })
            .await?,
    };
    interrupt_trial_publication("forward-catalog-opened");
    let transactions = ApplicationTransactions::new(store.clone());
    if transactions
        .verify_forward_catalog(activation, &marker, &saved.preparation.snapshot)
        .await?
        != reused
    {
        return Err(Error::IncompatibleStore);
    }
    if !reused {
        transactions
            .mark_forward_catalog(activation, marker.clone(), verify_witness)
            .await?;
        interrupt_trial_publication("forward-catalog-committed");
    }
    drop(transactions);
    store.shutdown().await.map_err(|_| Error::UnknownCommit)?;
    let snapshot = Store {
        db: candidate
            .snapshot()
            .await
            .map_err(|_| Error::UnknownCommit)?,
    };
    let confirmed = ApplicationTransactions::new(snapshot.clone())
        .verify_forward_catalog(activation, &marker, &saved.preparation.snapshot)
        .await
        .map_err(|_| Error::UnknownCommit)?;
    snapshot
        .shutdown()
        .await
        .map_err(|_| Error::UnknownCommit)?;
    verify_witness().map_err(|_| Error::UnknownCommit)?;
    if !confirmed {
        return Err(Error::UnknownCommit);
    }
    Ok(reused)
}

/// Observe a synthetic first-readiness callback while all existing owners are held.
/// The permanent catalog fence remains intact. A real launcher handoff must still
/// transfer these owners to the selected runtime and fence every serving request.
#[cfg(test)]
pub(super) async fn probe_forward_activation(
    home: PathBuf,
    update_id: String,
    probe: impl FnOnce(&super::FixtureForwardActivationWitness) -> Result<()>,
) -> Result<super::FixtureForwardActivationWitness> {
    probe_forward_activation_with_file(home, update_id, |witness, _| probe(witness)).await
}

#[cfg(test)]
pub(super) async fn probe_forward_activation_with_file(
    home: PathBuf,
    update_id: String,
    probe: impl FnOnce(
        &super::FixtureForwardActivationWitness,
        &crate::backend::ExclusiveTrialFile,
    ) -> Result<()>,
) -> Result<super::FixtureForwardActivationWitness> {
    use crate::{application::ForwardServiceActivation, backend::ExclusiveTrialFile};

    let directories = TrialRestoreDirectories::open(&home)?;
    let receipt = TrialRestoreDirectories::pinned(&directories.state)
        .join(format!(".statev2-trial-{update_id}.receipt-v1.json"));
    let receipt_bytes = read_trial_file(&receipt)?.ok_or(Error::IncompatibleStore)?;
    let saved: IsolatedTrialVerification =
        serde_json::from_slice(&receipt_bytes).map_err(|_| Error::IncompatibleStore)?;
    validate_observation(&saved)?;
    validate_isolated_trial_request(&home, &update_id, &saved.request)?;
    validate_isolated_trial_preparation(&saved.request, &saved.preparation)?;
    if saved.sealed_publication.as_ref().map(|record| record.phase)
        != Some(SealedPromotionPhase::ForwardCommitted)
        || serde_json::to_vec(&saved).map_err(|_| Error::IncompatibleStore)? != receipt_bytes
    {
        return Err(Error::IncompatibleStore);
    }
    let lease =
        TrialLease::open_for(home, &saved.request, Some(SealedMove::PublishIntended)).await?;
    directories.verify(&lease.home)?;
    let state = TrialRestoreDirectories::pinned(&lease.directories.state);
    let candidate = ExclusiveTrialFile::acquire(state.join("statev2.omdb"), MAX_TRIAL_FILE_BYTES)?;
    let activation = lease
        .verify_promotion_runtimes(&saved)
        .await?
        .ok_or(Error::IncompatibleStore)?;
    let selected = forward_selection_bytes(&lease.home, activation, &receipt_bytes)?;
    let selection =
        TrialRestoreDirectories::pinned(&lease.directories.runtime).join("service-state.json");
    let marker = ForwardServiceActivation {
        update_id: update_id.clone(),
        forward_selection_sha256: trial_document_sha256(&selected),
    };
    let marker_file = state.join(format!(".statev2-forward-{update_id}.json"));
    let marker_bytes = serde_json::to_vec(&marker).map_err(|_| Error::IncompatibleStore)?;
    let verify = || {
        lease.verify_inputs()?;
        lease.verify_published_layout(&update_id)?;
        if trial_file_identity(&candidate.verified_file()?)?
            != (saved.preparation.database.clone(), 1)
            || read_trial_file(&receipt)?.as_deref() != Some(receipt_bytes.as_slice())
            || read_trial_file(&selection)?.as_deref() != Some(selected.as_slice())
            || read_trial_file(&marker_file)?.as_deref() != Some(marker_bytes.as_slice())
        {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    };
    verify()?;
    // No recovery or writable open here. Only the existing forward owner can
    // recover an interrupted seal replacement before this probe is admissible.
    let store = Store {
        db: candidate.snapshot().await?,
    };
    store.verify_bootstrap_schema().await?;
    let transactions = ApplicationTransactions::new(store.clone());
    if !transactions
        .verify_forward_catalog(activation, &marker, &saved.preparation.snapshot)
        .await?
    {
        return Err(Error::IncompatibleStore);
    }
    let witness = super::FixtureForwardActivationWitness {
        activation: activation.clone(),
        database: saved.preparation.database.clone(),
        receipt_sha256: trial_document_sha256(&receipt_bytes),
        selection_sha256: marker.forward_selection_sha256.clone(),
    };
    super::tests::interrupt_trial_publication("forward-readiness-before-probe");
    probe(&witness, &candidate)?;
    super::tests::interrupt_trial_publication("forward-readiness-after-probe");
    lease.verify_promotion_runtimes(&saved).await?;
    verify()?;
    if !transactions
        .verify_forward_catalog(activation, &marker, &saved.preparation.snapshot)
        .await?
    {
        return Err(Error::IncompatibleStore);
    }
    drop(transactions);
    store.shutdown().await?;
    verify()?;
    Ok(witness)
}

#[cfg(test)]
fn persist_forward_selection(
    runtime: &fs::File,
    selection: &Path,
    current: &[u8],
    proposed: &[u8],
    verify: impl FnOnce() -> Result<()>,
) -> Result<bool> {
    use super::tests::interrupt_trial_publication;

    let reused = current == proposed;
    let stage = if reused {
        None
    } else {
        let mut stage = tempfile::Builder::new()
            .prefix(".native-forward-selection-")
            .tempfile_in(TrialRestoreDirectories::pinned(runtime))
            .map_err(io_error)?;
        stage.write_all(proposed).map_err(io_error)?;
        stage.as_file().sync_all().map_err(io_error)?;
        Some(stage)
    };
    verify()?;
    if read_trial_file(selection)?.as_deref() != Some(current) {
        return Err(Error::IncompatibleStore);
    }
    if let Some(stage) = stage {
        interrupt_trial_publication("forward-selection-written");
        stage
            .persist(selection)
            .map_err(|error| io_error(error.error))?;
        interrupt_trial_publication("forward-selection-renamed");
    }
    runtime.sync_all().map_err(|_| Error::UnknownCommit)?;
    if read_trial_file(selection)
        .map_err(|_| Error::UnknownCommit)?
        .as_deref()
        != Some(proposed)
    {
        return Err(Error::UnknownCommit);
    }
    interrupt_trial_publication("forward-selection-durable");
    Ok(reused)
}

pub(super) async fn move_sealed(
    home: PathBuf,
    update_id: String,
    movement: SealedMove,
) -> Result<IsolatedTrialPublication> {
    let directories = TrialRestoreDirectories::open(&home)?;
    let receipt = TrialRestoreDirectories::pinned(&directories.state)
        .join(format!(".statev2-trial-{update_id}.receipt-v1.json"));
    let mut saved = read_trial_receipt::<IsolatedTrialVerification>(&receipt)?
        .ok_or(Error::IncompatibleStore)?;
    validate_observation(&saved)?;
    if saved
        .sealed_publication
        .as_ref()
        .is_some_and(|sealed| sealed.phase == SealedPromotionPhase::ForwardCommitted)
    {
        return Err(Error::IncompatibleStore);
    }
    if matches!(movement, SealedMove::Publish) && saved.promotion_intent.is_some() {
        // An intent must not enter the legacy database-only publication path.
        return Err(Error::IncompatibleStore);
    }
    if matches!(movement, SealedMove::PublishIntended) {
        if saved.promotion_intent.is_none()
            || saved.sealed_publication.as_ref().is_some_and(|p| {
                matches!(
                    p.phase,
                    SealedPromotionPhase::RollingBack | SealedPromotionPhase::RolledBack
                )
            })
        {
            return Err(Error::IncompatibleStore);
        }
    }
    let activation = saved
        .request
        .activation
        .as_ref()
        .ok_or(Error::IncompatibleStore)?
        .clone();
    validate_isolated_trial_request(&home, &update_id, &saved.request)?;
    validate_isolated_trial_preparation(&saved.request, &saved.preparation)?;
    let lease = TrialLease::open_for(home.clone(), &saved.request, Some(movement)).await?;
    directories.verify(&home)?;
    let state = TrialRestoreDirectories::pinned(&lease.directories.state);
    let canonical = state.join("statev2.omdb");
    let original = preserved_path(&state, &update_id);
    lease.verify_promotion_bindings(&saved).await?;
    lease.verify_sealed_binding(&saved)?;
    let rollback_intent =
        matches!(movement, SealedMove::Rollback) && saved.promotion_intent.is_some();
    let rollback_staged = rollback_intent && disposable_file_exists(&lease.trial)?;
    let phase = saved
        .sealed_publication
        .as_ref()
        .map(|publication| publication.phase);
    // Before publication starts, both files must still be at their original
    // names and the source must have no extra preservation link.
    if rollback_intent
        && phase.is_none()
        && (!rollback_staged || super::trial_entry_exists(&original)?)
    {
        return Err(Error::IncompatibleStore);
    }
    // Keep the staged candidate and remove only our verified extra source link
    // when publication has not replaced the canonical name.
    if rollback_staged {
        if phase == Some(SealedPromotionPhase::Published) {
            return Err(Error::IncompatibleStore);
        }
        let candidate = lease
            .open_candidate(
                lease.trial.clone(),
                &saved.request,
                &saved.preparation,
                1,
                false,
            )
            .await?;
        lease.live.verify_at(&canonical, lease.source_links)?;
        lease.verify_inputs()?;
        let reused = phase == Some(SealedPromotionPhase::RolledBack);
        if !reused {
            record_sealed_phase(
                &lease,
                &receipt,
                &mut saved,
                SealedPromotionPhase::RollingBack,
            )
            .await?;
        }
        if super::trial_entry_exists(&original)? {
            lease.live.verify_at(&canonical, 2)?;
            lease.live.verify_at(&original, 2)?;
            fs::remove_file(&original).map_err(|_| Error::UnknownCommit)?;
            lease.sync_publication()?;
            #[cfg(test)]
            super::tests::interrupt_trial_publication("intended-rollback-unlinked");
        }
        lease.live.verify_at(&canonical, 1)?;
        candidate.verify()?;
        record_sealed_phase(
            &lease,
            &receipt,
            &mut saved,
            SealedPromotionPhase::RolledBack,
        )
        .await?;
        return Ok(IsolatedTrialPublication {
            activation,
            database: lease.live.identity.clone(),
            preserved_database: candidate.identity.clone(),
            reused,
        });
    }
    let (incoming_path, retained_path, _after_preserve, _after_rename) = match movement {
        SealedMove::Publish | SealedMove::PublishIntended => (
            lease.trial.clone(),
            original,
            if matches!(movement, SealedMove::PublishIntended) {
                "intended-preserved"
            } else {
                "isolated-preserved"
            },
            if matches!(movement, SealedMove::PublishIntended) {
                "intended-renamed"
            } else {
                "isolated-renamed"
            },
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
        SealedMove::Publish | SealedMove::PublishIntended if reused => (canonical.clone(), 1),
        SealedMove::Publish | SealedMove::PublishIntended => (incoming_path.clone(), 1),
        SealedMove::Rollback if reused => (retained_path.clone(), 1),
        SealedMove::Rollback => (canonical.clone(), outgoing_links),
    };
    let candidate = lease
        .open_candidate(
            candidate_path,
            &saved.request,
            &saved.preparation,
            candidate_links,
            matches!(movement, SealedMove::Publish | SealedMove::PublishIntended),
        )
        .await?;
    let (outgoing, incoming) = match movement {
        SealedMove::Publish | SealedMove::PublishIntended => (&lease.live, &candidate),
        SealedMove::Rollback => (&candidate, &lease.live),
    };
    if matches!(movement, SealedMove::PublishIntended) {
        let phase = saved.sealed_publication.as_ref().map(|p| p.phase);
        if phase == Some(SealedPromotionPhase::Published) && !reused {
            return Err(Error::IncompatibleStore);
        }
        if phase.is_none() {
            record_sealed_phase(
                &lease,
                &receipt,
                &mut saved,
                SealedPromotionPhase::Publishing,
            )
            .await?;
        }
    } else if saved.sealed_publication.is_some() {
        let phase = saved.sealed_publication.as_ref().unwrap().phase;
        if phase == SealedPromotionPhase::RolledBack && !reused {
            return Err(Error::IncompatibleStore);
        }
        if phase != SealedPromotionPhase::RolledBack {
            record_sealed_phase(
                &lease,
                &receipt,
                &mut saved,
                SealedPromotionPhase::RollingBack,
            )
            .await?;
        }
    }
    let verify_binding = || {
        lease.verify_ownership()?;
        match movement {
            SealedMove::Publish | SealedMove::PublishIntended => {
                lease.verify_activation(&saved.request)?
            }
            SealedMove::Rollback => {
                lease.pending_selection(
                    &update_id,
                    &activation.from_version,
                    &activation.target_version,
                    true,
                )?;
            }
        }
        lease.verify_sealed_binding(&saved)?;
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
    if saved.sealed_publication.is_some() {
        let phase = if matches!(movement, SealedMove::Rollback) {
            SealedPromotionPhase::RolledBack
        } else {
            SealedPromotionPhase::Published
        };
        record_sealed_phase(&lease, &receipt, &mut saved, phase).await?;
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

impl ServiceSelection {
    fn is_pending_for(
        &self,
        home: &Path,
        update_id: &str,
        from: &str,
        target: &str,
        bound: bool,
    ) -> bool {
        let supported_protocol = if bound {
            self.protocol == 5
        } else {
            matches!(self.protocol, 3 | 4)
        };
        supported_protocol
            && self.active_version == from
            && self.update.id == update_id
            && self.update.from_version == from
            && self.update.target_version == target
            && self.update.status == "pending"
            && self.update.db_path == home.join("userdata/statev2.omdb")
            && exact_service_version(from)
            && exact_service_version(target)
            && compare_service_versions(target, from) == std::cmp::Ordering::Greater
    }
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
    validate_observation(&saved)?;
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
    lease.verify_promotion_bindings(&saved).await?;
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
        validate_observation(&saved)?;
        if saved.request != request {
            return Err(Error::IncompatibleStore);
        }
        validate_isolated_trial_preparation(&request, &saved.preparation)?;
        lease.verify_candidate(&request, &saved.preparation).await?;
        lease.verify_promotion_bindings(&saved).await?;
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
        candidate_observation: None,
        promotion_intent: None,
        sealed_publication: None,
    };
    write_trial_receipt(
        &receipt,
        &TrialRestoreDirectories::pinned(&lease.directories.state),
        &verification,
    )?;
    lease.sync_publication()?;
    Ok(verification.preparation)
}

// The observation proves the exact stopped-candidate check. It grants no activation.
pub(super) fn validate_observation(saved: &IsolatedTrialVerification) -> Result<()> {
    let Some(observation) = &saved.candidate_observation else {
        return if saved.promotion_intent.is_none() && saved.sealed_publication.is_none() {
            Ok(())
        } else {
            Err(Error::IncompatibleStore)
        };
    };
    if observation.verification_json.len() > 4096 {
        return Err(Error::IncompatibleStore);
    }
    let input: IsolatedTrialVerification = serde_json::from_str(&observation.verification_json)
        .map_err(|_| Error::IncompatibleStore)?;
    let activation = saved
        .request
        .activation
        .as_ref()
        .ok_or(Error::IncompatibleStore)?;
    let witness = &observation.witness;
    let digest: String = Sha256::digest(observation.verification_json.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if input.candidate_observation.is_some()
        || input.promotion_intent.is_some()
        || input.sealed_publication.is_some()
        || input.request != saved.request
        || input.preparation != saved.preparation
        || witness.protocol != 1
        || witness.status != "prepared-isolated"
        || witness.update_id != activation.update_id
        || witness.target_version != activation.target_version
        || witness.entry_sha256 != activation.target_entry_sha256
        || witness.helper_sha256 != activation.target_helper_sha256
        || witness.verification_sha256 != digest
    {
        return Err(Error::IncompatibleStore);
    }
    if let Some(intent) = &saved.promotion_intent {
        if intent.version != 1
            || intent.verification_sha256 != witness.verification_sha256
            || ![
                &intent.verification_sha256,
                &intent.source_entry_sha256,
                &intent.source_helper_sha256,
                &intent.source_helper_schema_sha256,
            ]
            .into_iter()
            .all(|digest| super::valid_digest(digest))
        {
            return Err(Error::IncompatibleStore);
        }
    }
    if let Some(publication) = &saved.sealed_publication {
        if saved.promotion_intent.is_none()
            || publication.version != 1
            || !super::valid_digest(&publication.selection_sha256)
        {
            return Err(Error::IncompatibleStore);
        }
    }
    Ok(())
}

pub(super) async fn record_observation(
    home: PathBuf,
    update_id: String,
    observation: CandidatePreparationObservation,
) -> Result<serde_json::Value> {
    let mut proposed: IsolatedTrialVerification =
        serde_json::from_str(&observation.verification_json)
            .map_err(|_| Error::IncompatibleStore)?;
    if proposed.candidate_observation.is_some()
        || proposed.promotion_intent.is_some()
        || proposed.sealed_publication.is_some()
    {
        return Err(Error::IncompatibleStore);
    }
    validate_isolated_trial_request(&home, &update_id, &proposed.request)?;
    validate_isolated_trial_preparation(&proposed.request, &proposed.preparation)?;
    proposed.candidate_observation = Some(observation);
    validate_observation(&proposed)?;
    let lease = TrialLease::open(home, &proposed.request).await?;
    let receipt = lease.trial.with_extension("receipt-v1.json");
    let saved = read_trial_receipt::<IsolatedTrialVerification>(&receipt)?
        .ok_or(Error::IncompatibleStore)?;
    validate_observation(&saved)?;
    proposed.promotion_intent = saved.promotion_intent.clone();
    proposed.sealed_publication = saved.sealed_publication.clone();
    if saved.request != proposed.request
        || saved.preparation != proposed.preparation
        || (saved.candidate_observation.is_some() && saved != proposed)
    {
        return Err(Error::IncompatibleStore);
    }
    lease
        .verify_candidate(&proposed.request, &proposed.preparation)
        .await?;
    let reused = saved.candidate_observation.is_some();
    if !reused {
        let bytes = serde_json::to_vec(&proposed).map_err(|_| Error::IncompatibleStore)?;
        if bytes.len() > 8192 {
            return Err(Error::IncompatibleStore);
        }
        let directory = TrialRestoreDirectories::pinned(&lease.directories.state);
        let mut stage = tempfile::NamedTempFile::new_in(directory).map_err(io_error)?;
        stage.write_all(&bytes).map_err(io_error)?;
        #[cfg(test)]
        super::tests::interrupt_trial_publication("candidate-observation-written");
        stage.as_file().sync_all().map_err(io_error)?;
        lease.verify_inputs()?;
        lease.verify_activation(&proposed.request)?;
        if read_trial_receipt::<IsolatedTrialVerification>(&receipt)?.as_ref() != Some(&saved) {
            return Err(Error::IncompatibleStore);
        }
        stage
            .persist(&receipt)
            .map_err(|error| io_error(error.error))?;
    }
    lease.sync_publication()?;
    #[cfg(test)]
    if !reused {
        super::tests::interrupt_trial_publication("candidate-observation-durable");
    }
    if read_trial_receipt::<IsolatedTrialVerification>(&receipt)?.as_ref() != Some(&proposed) {
        return Err(Error::IncompatibleStore);
    }
    lease
        .verify_candidate(&proposed.request, &proposed.preparation)
        .await?;
    lease.verify_promotion_bindings(&proposed).await?;
    Ok(
        serde_json::json!({"witness": proposed.candidate_observation.unwrap().witness, "reused": reused}),
    )
}

// The capability command is read-only. Bound both pipes and execution time before
// extending a receipt that an older rollback helper would refuse to parse.
async fn verify_intent_helper(
    path: &Path,
    schema: &str,
    publication: bool,
    fence_helper_sha256: Option<&str>,
) -> Result<()> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    let pinned = if let Some(sha256) = fence_helper_sha256 {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        let file = crate::backend::open_regular_file(path, &mut options)?;
        if trial_file_digest(&file)? != sha256 {
            return Err(Error::IncompatibleStore);
        }
        Some(file)
    } else {
        None
    };
    // Resolve through our open file so the probe executes the artifact we hashed.
    let pinned_path = pinned.as_ref().map(|file| {
        PathBuf::from(format!(
            "/proc/{}/fd/{}",
            std::process::id(),
            file.as_raw_fd()
        ))
    });
    let mut child = tokio::process::Command::new(pinned_path.as_deref().unwrap_or(path))
        .arg("trial-capabilities")
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(io_error)?;
    let stdout = child.stdout.take().ok_or(Error::IncompatibleStore)?;
    let stderr = child.stderr.take().ok_or(Error::IncompatibleStore)?;
    let read = async move {
        let mut output = Vec::new();
        let mut errors = Vec::new();
        let out = async { stdout.take(8193).read_to_end(&mut output).await };
        let err = async { stderr.take(8193).read_to_end(&mut errors).await };
        let (status, _, _) = tokio::try_join!(child.wait(), out, err).map_err(io_error)?;
        if !status.success() || output.len() > 8192 || !errors.is_empty() {
            return Err(Error::IncompatibleStore);
        }
        let frame: serde_json::Value =
            serde_json::from_slice(&output).map_err(|_| Error::IncompatibleStore)?;
        if frame["ok"] != true
            || frame["result"]["version"] != 1
            || frame["result"]["engine"] != "omdb"
            || frame["result"]["engineRevision"] != crate::application::OMDB_REVISION
            || frame["result"]["sealedTrialRollback"] != 1
            || frame["result"]["promotionIntent"] != 1
            || (publication && frame["result"]["sealedIntentPublication"] != 1)
            || (fence_helper_sha256.is_some()
                && frame["result"]["sealedGenericRestoreFence"]
                    != super::SEALED_GENERIC_RESTORE_FENCE_VERSION)
            || frame["result"]["targetSchemaSha256"] != schema
        {
            return Err(Error::IncompatibleStore);
        }
        Ok(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), read)
        .await
        .map_err(|_| Error::IncompatibleStore)?
}

pub(super) async fn record_promotion_intent(
    home: PathBuf,
    update_id: String,
    intent: NativePromotionIntent,
) -> Result<serde_json::Value> {
    let directories = TrialRestoreDirectories::open(&home)?;
    let receipt = TrialRestoreDirectories::pinned(&directories.state)
        .join(format!(".statev2-trial-{update_id}.receipt-v1.json"));
    let mut proposed = read_trial_receipt::<IsolatedTrialVerification>(&receipt)?
        .ok_or(Error::IncompatibleStore)?;
    validate_isolated_trial_request(&home, &update_id, &proposed.request)?;
    validate_isolated_trial_preparation(&proposed.request, &proposed.preparation)?;
    validate_observation(&proposed)?;
    if proposed
        .promotion_intent
        .as_ref()
        .is_some_and(|saved| saved != &intent)
    {
        return Err(Error::IncompatibleStore);
    }
    let saved = proposed.clone();
    let reused = proposed.promotion_intent.is_some();
    proposed.promotion_intent = Some(intent);
    validate_observation(&proposed)?;
    let lease = TrialLease::open(home.clone(), &proposed.request).await?;
    directories.verify(&home)?;
    if read_trial_receipt::<IsolatedTrialVerification>(&receipt)?.as_ref() != Some(&saved) {
        return Err(Error::IncompatibleStore);
    }
    lease
        .verify_candidate(&proposed.request, &proposed.preparation)
        .await?;
    lease.verify_promotion_bindings(&proposed).await?;
    if !reused {
        let bytes = serde_json::to_vec(&proposed).map_err(|_| Error::IncompatibleStore)?;
        if bytes.len() > 8192 {
            return Err(Error::IncompatibleStore);
        }
        let mut stage = tempfile::NamedTempFile::new_in(TrialRestoreDirectories::pinned(
            &lease.directories.state,
        ))
        .map_err(io_error)?;
        stage.write_all(&bytes).map_err(io_error)?;
        #[cfg(test)]
        super::tests::interrupt_trial_publication("promotion-intent-written");
        stage.as_file().sync_all().map_err(io_error)?;
        lease.verify_inputs()?;
        lease.verify_activation(&proposed.request)?;
        let activation = proposed
            .request
            .activation
            .as_ref()
            .ok_or(Error::IncompatibleStore)?;
        let binding = proposed.promotion_intent.as_ref().unwrap();
        lease.verify_installed_runtime(
            &activation.from_version,
            &binding.source_entry_sha256,
            &binding.source_helper_sha256,
        )?;
        if read_trial_receipt::<IsolatedTrialVerification>(&receipt)?.as_ref() != Some(&saved) {
            return Err(Error::IncompatibleStore);
        }
        stage
            .persist(&receipt)
            .map_err(|error| io_error(error.error))?;
    }
    lease.sync_publication()?;
    #[cfg(test)]
    if !reused {
        super::tests::interrupt_trial_publication("promotion-intent-durable");
    }
    if read_trial_receipt::<IsolatedTrialVerification>(&receipt)?.as_ref() != Some(&proposed) {
        return Err(Error::IncompatibleStore);
    }
    lease
        .verify_candidate(&proposed.request, &proposed.preparation)
        .await?;
    lease.verify_promotion_bindings(&proposed).await?;
    Ok(serde_json::json!({"intent": proposed.promotion_intent, "reused": reused}))
}
