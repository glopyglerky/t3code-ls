//! Task-folder storage and the resolved-path lookup index.

use std::collections::BTreeSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::application::{
    ApplicationCatalog, ApplicationTransactions, Session, decode_catalog, decode_row, row_prefix,
    schema_key, table,
};
use crate::application_rows::{
    delete_row, integer, managed_marker, read_row, text, text_cell, validate_table, write_row,
};
use crate::backend::Transaction;
use crate::{Error, Result, Store, request_digest, store_key};

const TABLE: &str = "task_folders";
const COLUMNS: &[&str] = &[
    "root",
    "real_root",
    "project_id",
    "project_root",
    "anchor",
    "project_path",
    "project_is_worktree",
    "repositories_json",
    "created_at",
];
const OWNER: &[u8] = b"task-folders-v1";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Alias {
    real_root: String,
    root: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preparation {
    pub prepared: bool,
    indexed_rows: u64,
    after: Option<String>,
}

fn location(catalog: &ApplicationCatalog, suffix: &str) -> Vec<u8> {
    store_key(&format!(
        "application/generation/{}/task-folders/v1/{suffix}",
        catalog.generation
    ))
}
fn end(prefix: &[u8]) -> Vec<u8> {
    let mut end = prefix.to_vec();
    end.push(255);
    end
}
fn alias_prefix(catalog: &ApplicationCatalog, path: &str) -> Vec<u8> {
    location(catalog, &format!("real/{}/", request_digest(&json!(path))))
}
fn alias_key(catalog: &ApplicationCatalog, alias: &Alias) -> Vec<u8> {
    let mut key = alias_prefix(catalog, &alias.real_root);
    key.extend_from_slice(request_digest(&json!(alias.root)).as_bytes());
    key
}

fn alias(row: &Map<String, Value>) -> Result<Alias> {
    if !matches!(integer(row, "project_is_worktree")?, 0 | 1) {
        return Err(Error::IncompatibleStore);
    }
    Ok(Alias {
        root: text(row, "root")?,
        real_root: text(row, "real_root")?,
    })
}

async fn add_alias(
    tx: &mut Transaction,
    catalog: &ApplicationCatalog,
    alias: &Alias,
) -> Result<()> {
    let key = alias_key(catalog, alias);
    let bytes = serde_json::to_vec(alias).map_err(crate::json_error)?;
    if tx
        .get(&key)
        .await?
        .is_some_and(|previous| previous != bytes)
    {
        return Err(Error::IncompatibleStore);
    }
    tx.put(key, bytes).await
}

async fn remove_alias(
    tx: &mut Transaction,
    catalog: &ApplicationCatalog,
    alias: &Alias,
) -> Result<()> {
    let key = alias_key(catalog, alias);
    let bytes = serde_json::to_vec(alias).map_err(crate::json_error)?;
    if tx.get(&key).await?.as_ref() != Some(&bytes) {
        return Err(Error::IncompatibleStore);
    }
    tx.delete(key).await
}

async fn require_prepared(session: &mut Session) -> Result<()> {
    if session
        .transaction
        .get(&managed_marker(&session.catalog, TABLE))
        .await?
        .as_deref()
        != Some(OWNER)
    {
        return Err(Error::Invalid("task-folder rows are not prepared".into()));
    }
    Ok(())
}

impl Store {
    pub async fn prepare_application_task_folders(&self) -> Result<Preparation> {
        let mut tx = self
            .db
            .begin_reserved(Duration::from_secs(5), Duration::from_secs(60))
            .await?;
        let catalog = decode_catalog(
            &tx.get(&schema_key())
                .await?
                .ok_or(Error::IncompatibleStore)?,
        )?;
        validate_table(&catalog, TABLE, COLUMNS, &["root"])?;
        let state_key = location(&catalog, "preparation");
        let mut state = tx
            .get(&state_key)
            .await?
            .as_ref()
            .map(|bytes| {
                serde_json::from_slice::<Preparation>(bytes).map_err(|_| Error::IncompatibleStore)
            })
            .transpose()?
            .unwrap_or_default();
        let managed = managed_marker(&catalog, TABLE);
        let marker = tx.get(&managed).await?;
        if marker.as_deref().is_some_and(|marker| marker != OWNER)
            || state.prepared != marker.is_some()
        {
            return Err(Error::IncompatibleStore);
        }
        if state.prepared {
            tx.rollback().await?;
            return Ok(state);
        }
        let prefix = row_prefix(&catalog.generation, TABLE)?;
        let mut cursor = prefix.clone();
        if let Some(after) = &state.after {
            if after.len() != 64
                || !after
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(Error::IncompatibleStore);
            }
            cursor.extend_from_slice(after.as_bytes());
            cursor.push(0);
        }
        let page = tx.scan(&cursor, &end(&prefix), 32).await?;
        state.prepared = page.len() < 32;
        for (key, bytes) in page {
            let source = decode_row(&catalog, table(&catalog, TABLE)?, &key, &bytes)?;
            add_alias(&mut tx, &catalog, &alias(&source.row)?).await?;
            let suffix = key
                .strip_prefix(prefix.as_slice())
                .ok_or(Error::IncompatibleStore)?;
            state.after = Some(
                std::str::from_utf8(suffix)
                    .map_err(|_| Error::IncompatibleStore)?
                    .into(),
            );
            state.indexed_rows = state
                .indexed_rows
                .checked_add(1)
                .ok_or(Error::IncompatibleStore)?;
        }
        if state.prepared {
            state.after = None;
            tx.put(managed, OWNER.to_vec()).await?;
        }
        tx.put(
            state_key,
            serde_json::to_vec(&state).map_err(crate::json_error)?,
        )
        .await?;
        tx.commit().await?;
        Ok(state)
    }
}

async fn find(session: &mut Session, paths: Vec<String>) -> Result<Option<Map<String, Value>>> {
    require_prepared(session).await?;
    let catalog = &session.catalog;
    let tx = &mut session.transaction;
    let mut roots = BTreeSet::new();
    for path in paths.into_iter().collect::<BTreeSet<_>>() {
        roots.insert(path.clone());
        let prefix = alias_prefix(catalog, &path);
        let limit = end(&prefix);
        let mut start = prefix.clone();
        loop {
            let page = tx.scan(&start, &limit, 64).await?;
            let complete = page.len() < 64;
            for (key, bytes) in page {
                let witness: Alias =
                    serde_json::from_slice(&bytes).map_err(|_| Error::IncompatibleStore)?;
                if witness.real_root != path || alias_key(catalog, &witness) != key {
                    return Err(Error::IncompatibleStore);
                }
                let source = read_row(tx, catalog, TABLE, &[text_cell(&witness.root)])
                    .await?
                    .ok_or(Error::IncompatibleStore)?;
                if text(&source.row, "real_root")? != path {
                    return Err(Error::IncompatibleStore);
                }
                roots.insert(witness.root);
                start = key;
                start.push(0);
            }
            if complete {
                break;
            }
        }
    }
    let mut roots = roots.into_iter().collect::<Vec<_>>();
    roots.sort_by(|left, right| {
        right
            .chars()
            .count()
            .cmp(&left.chars().count())
            .then_with(|| left.cmp(right))
    });
    for root in roots {
        if let Some(row) = read_row(tx, catalog, TABLE, &[text_cell(&root)]).await? {
            return Ok(Some(row.row));
        }
    }
    Ok(None)
}

impl ApplicationTransactions {
    pub async fn task_folders_find(
        &mut self,
        id: &str,
        paths: Vec<String>,
    ) -> Result<Option<Map<String, Value>>> {
        let mut session = self.take(id)?;
        let result = find(&mut session, paths).await;
        self.finish(id, session, result).await
    }

    pub async fn task_folders_upsert(
        &mut self,
        id: &str,
        mut row: Map<String, Value>,
    ) -> Result<()> {
        let mut session = self.take(id)?;
        let result = async {
            require_prepared(&mut session).await?;
            let tx = &mut session.transaction;
            tx.require_write()?;
            let catalog = &session.catalog;
            let next = alias(&row)?;
            if let Some(old) = read_row(tx, catalog, TABLE, &[text_cell(&next.root)]).await? {
                remove_alias(tx, catalog, &alias(&old.row)?).await?;
                for field in ["project_id", "project_root", "anchor", "created_at"] {
                    row.insert(
                        field.into(),
                        old.row
                            .get(field)
                            .cloned()
                            .ok_or(Error::IncompatibleStore)?,
                    );
                }
            }
            write_row(tx, catalog, TABLE, row).await?;
            add_alias(tx, catalog, &next).await
        }
        .await;
        self.finish(id, session, result).await
    }

    pub async fn task_folders_delete(&mut self, id: &str, root: &str) -> Result<()> {
        let mut session = self.take(id)?;
        let result = async {
            require_prepared(&mut session).await?;
            let tx = &mut session.transaction;
            tx.require_write()?;
            let catalog = &session.catalog;
            let key = [text_cell(root)];
            if let Some(old) = read_row(tx, catalog, TABLE, &key).await? {
                remove_alias(tx, catalog, &alias(&old.row)?).await?;
                delete_row(tx, catalog, TABLE, &key).await?;
            }
            Ok(())
        }
        .await;
        self.finish(id, session, result).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::ApplicationTransactionMode;
    use crate::application_rows::int_cell;
    use crate::test_support::TestFixture;

    fn folder(root: &str, real_root: &str, project: &str) -> Map<String, Value> {
        Map::from_iter([
            ("root".into(), text_cell(root)),
            ("real_root".into(), text_cell(real_root)),
            ("project_id".into(), text_cell(project)),
            ("project_root".into(), text_cell("/fixture/project")),
            ("anchor".into(), text_cell("/fixture")),
            ("project_path".into(), text_cell("/fixture/project")),
            ("project_is_worktree".into(), int_cell(0)),
            ("repositories_json".into(), text_cell("[]")),
            ("created_at".into(), text_cell("2026-11-21T00:00:00.000Z")),
        ])
    }

    async fn find_root(app: &mut ApplicationTransactions, path: &str) -> Option<String> {
        app.begin_mode("read", ApplicationTransactionMode::Read, None)
            .await
            .unwrap();
        let row = app
            .task_folders_find("read", vec![path.into(), "/real/parent".into()])
            .await
            .unwrap();
        app.rollback("read").await.unwrap();
        row.map(|row| text(&row, "root").unwrap())
    }

    #[tokio::test]
    async fn aliases_follow_nested_roots_rollback_and_owner_handoff() {
        let fixture = TestFixture::start().await;
        let store = fixture.initialize().await;
        store.bootstrap_application().await.unwrap();
        let mut app = ApplicationTransactions::new(store.clone());
        let parent = folder("/task/parent", "/real/parent", "project:original");
        let child = folder("/task/parent/child", "/real/parent/child", "project:child");
        app.begin("imported").await.unwrap();
        for row in [parent.clone(), child.clone()] {
            let primary = vec![row["root"].clone()];
            app.put("imported", TABLE, primary, row).await.unwrap();
        }
        app.commit("imported").await.unwrap();
        while !store
            .prepare_application_task_folders()
            .await
            .unwrap()
            .prepared
        {}

        assert_eq!(
            find_root(&mut app, "/real/parent/child").await.as_deref(),
            Some("/task/parent/child")
        );

        app.begin("raw").await.unwrap();
        let raw_write = app
            .put("raw", TABLE, vec![parent["root"].clone()], parent)
            .await;
        assert!(matches!(raw_write, Err(Error::Invalid(_))));

        let moved = folder(
            "/task/parent/child",
            "/relocated/child",
            "project:replacement",
        );
        app.begin("discarded").await.unwrap();
        app.task_folders_upsert("discarded", moved.clone())
            .await
            .unwrap();
        app.rollback("discarded").await.unwrap();
        assert_eq!(
            find_root(&mut app, "/real/parent/child").await.as_deref(),
            Some("/task/parent/child")
        );

        app.begin("move").await.unwrap();
        app.task_folders_upsert("move", moved).await.unwrap();
        let selected = app
            .task_folders_find("move", vec!["/relocated/child".into()])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(text(&selected, "project_id").unwrap(), "project:child");
        app.commit("move").await.unwrap();
        assert_eq!(
            find_root(&mut app, "/real/parent/child").await.as_deref(),
            Some("/task/parent")
        );

        app.begin("delete").await.unwrap();
        app.task_folders_delete("delete", "/task/parent/child")
            .await
            .unwrap();
        app.commit("delete").await.unwrap();
        assert_eq!(
            find_root(&mut app, "/relocated/child").await.as_deref(),
            Some("/task/parent")
        );
        store.shutdown().await.unwrap();
    }
}
