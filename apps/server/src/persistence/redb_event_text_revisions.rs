//! Physical rows for the opt-in assistant text revision layout.

use super::*;
use crate::application::validate_row_identity;
use crate::application_json::JsonField;
use std::borrow::Cow;

const MAX_CHAIN: usize = 8;
const MAX_PAYLOAD_BYTES: usize = 256 * 1024;
const MAX_SUFFIX_BYTES: usize = 32 * 1024;
const MAX_ROW_BYTES: usize = 1024 * 1024;
const MAX_ID_BYTES: usize = 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredRevision {
    row: ApplicationRow,
    text_revision: TextRevision,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TextRevision {
    previous: EventRef,
    previous_text_bytes: usize,
    payload_bytes: usize,
    suffix: String,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct EventRef {
    sequence: u64,
    stream_version: i64,
    event_id: String,
}

impl From<&EventRecord> for EventRef {
    fn from(event: &EventRecord) -> Self {
        Self {
            sequence: event.sequence,
            stream_version: event.stream_version,
            event_id: event.row.event_id.clone(),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Head {
    thread_id: String,
    message_id: String,
    event: EventRef,
}

struct TextPayload {
    message_id: String,
    fields: Vec<JsonField>,
}

fn message_update(event: &EventRecord) -> bool {
    event.row.aggregate_kind == "thread"
        && event.row.event_type == "message.updated"
        && event.row.application_event_version == 2
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID_BYTES
}

fn json_string(fields: &[JsonField], name: &str) -> Option<String> {
    serde_json::from_str(field(fields, name)?).ok()
}

impl TextPayload {
    fn parse(event: &EventRecord) -> Result<Option<Self>> {
        let payload = &event.row.payload_json;
        if !message_update(event)
            || !matches!(event.row.actor_kind.as_str(), "provider" | "server")
            || !valid_id(&event.row.event_id)
            || !valid_id(&event.row.stream_id)
            || payload.len() > MAX_PAYLOAD_BYTES
        {
            return Ok(None);
        }
        let Some(fields) = object_fields(payload)? else {
            return Ok(None);
        };
        let names: BTreeSet<_> = fields.iter().map(|field| field.name.as_str()).collect();
        if names.len() != fields.len()
            || json_string(&fields, "role").as_deref() != Some("assistant")
            || field(&fields, "streaming") != Some("true")
            || json_string(&fields, "threadId").as_deref() != Some(event.row.stream_id.as_str())
            || !["runId", "nodeId"].into_iter().all(|name| {
                field(&fields, name) == Some("null")
                    || json_string(&fields, name).is_some_and(|id| valid_id(&id))
            })
            || !["createdAt", "updatedAt", "createdBy", "creationSource"]
                .into_iter()
                .all(|name| json_string(&fields, name).is_some_and(|value| !value.is_empty()))
            || !field(&fields, "attachments").is_some_and(|value| value.starts_with('['))
            || !field(&fields, "text").is_some_and(|value| value.starts_with('"'))
            || render_fields(&fields) != *payload
        {
            return Ok(None);
        }
        let Some(message_id) = json_string(&fields, "id").filter(|id| valid_id(id)) else {
            return Ok(None);
        };
        Ok(Some(Self { message_id, fields }))
    }

    fn matches(&self, other: &Self) -> bool {
        self.message_id == other.message_id
            && ["runId", "nodeId", "createdAt"]
                .into_iter()
                .all(|name| field(&self.fields, name) == field(&other.fields, name))
    }

    fn text_token(&self) -> &str {
        // parse requires a valid JSON string token.
        let quoted = field(&self.fields, "text").expect("text field was verified");
        &quoted[1..quoted.len() - 1]
    }

    fn with_text(mut self, encoded_text: String) -> String {
        set_field(&mut self.fields, "text", format!("\"{encoded_text}\""));
        render_fields(&self.fields)
    }
}

fn head_key(catalog: &ApplicationCatalog, thread: &str) -> Vec<u8> {
    key(
        catalog,
        &format!("text-v1/head/{}", request_digest(&json!(thread))),
    )
}

fn dependent_key(catalog: &ApplicationCatalog, sequence: u64) -> Vec<u8> {
    key(catalog, &format!("text-v1/dependent/{sequence}"))
}

async fn read_head(
    tx: &mut Transaction,
    catalog: &ApplicationCatalog,
    thread: &str,
) -> Result<Option<Head>> {
    let head: Option<Head> = tx
        .get(&head_key(catalog, thread))
        .await?
        .as_deref()
        .map(decode)
        .transpose()?;
    if head.as_ref().is_some_and(|head| head.thread_id != thread) {
        return Err(Error::IncompatibleStore);
    }
    Ok(head)
}

fn physical_revision(
    catalog: &ApplicationCatalog,
    definition: &ApplicationTable,
    encoded_key: &[u8],
    bytes: &[u8],
) -> Result<(EventRecord, TextRevision)> {
    if bytes.len() > MAX_ROW_BYTES {
        return Err(Error::IncompatibleStore);
    }
    let StoredRevision { row, text_revision } = decode(bytes)?;
    validate_row_identity(catalog, definition, encoded_key, &row)?;
    let event = EventRecord::from_row(row.row)?;
    if text_revision.previous.sequence == 0
        || text_revision.previous.sequence >= event.sequence
        || text_revision.previous.stream_version >= event.stream_version
        || !valid_id(&text_revision.previous.event_id)
        || text_revision.payload_bytes > MAX_PAYLOAD_BYTES
        || text_revision.previous_text_bytes == 0
        || text_revision.suffix.is_empty()
        || text_revision.suffix.len() > MAX_SUFFIX_BYTES
        || text_revision
            .previous_text_bytes
            .saturating_add(text_revision.suffix.len())
            >= text_revision.payload_bytes
    {
        return Err(Error::IncompatibleStore);
    }
    Ok((event, text_revision))
}

async fn restore(
    tx: &mut Transaction,
    catalog: &ApplicationCatalog,
    definition: &ApplicationTable,
    encoded_key: &[u8],
    bytes: &[u8],
    replay_base: Option<&ReplayBase>,
) -> Result<(EventRecord, usize)> {
    let mut links = vec![physical_revision(catalog, definition, encoded_key, bytes)?];
    let (mut base, base_depth) = loop {
        let (event, revision) = links.last().expect("at least one revision");
        let sequence = revision.previous.sequence;
        let dependent: EventRef = decode(
            &tx.get(&dependent_key(catalog, sequence))
                .await?
                .ok_or(Error::IncompatibleStore)?,
        )?;
        if dependent != EventRef::from(event) {
            return Err(Error::IncompatibleStore);
        }
        // An earlier event in this same ordered read already verified its chain.
        // Keep verifying this link's witness and the total depth on the fast path.
        if let Some(base) = replay_base.filter(|base| base.event.sequence == sequence) {
            if base.depth + links.len() > MAX_CHAIN {
                return Err(Error::IncompatibleStore);
            }
            break (Cow::Borrowed(&base.event), base.depth);
        }
        let encoded_key = event_key(catalog, sequence)?;
        let bytes = tx
            .get(&encoded_key)
            .await?
            .ok_or(Error::IncompatibleStore)?;
        if bytes.len() > MAX_ROW_BYTES {
            return Err(Error::IncompatibleStore);
        }
        if let Ok(row) = decode_row(catalog, definition, &encoded_key, &bytes) {
            break (Cow::Owned(EventRecord::from_row(row.row)?), 0);
        }
        if links.len() >= MAX_CHAIN {
            return Err(Error::IncompatibleStore);
        }
        links.push(physical_revision(
            catalog,
            definition,
            &encoded_key,
            &bytes,
        )?);
    };
    let depth = base_depth + links.len();
    for (mut event, revision) in links.into_iter().rev() {
        if EventRef::from(base.as_ref()) != revision.previous
            || base.row.stream_id != event.row.stream_id
        {
            return Err(Error::IncompatibleStore);
        }
        let prev = TextPayload::parse(&base)?.ok_or(Error::IncompatibleStore)?;
        let body = TextPayload::parse(&event)?.ok_or(Error::IncompatibleStore)?;
        if !body.matches(&prev)
            || !body.text_token().is_empty()
            || prev.text_token().len() != revision.previous_text_bytes
        {
            return Err(Error::IncompatibleStore);
        }
        let token = format!("{}{}", prev.text_token(), revision.suffix);
        // Validate that the suffix remains part of the same string token.
        serde_json::from_str::<String>(&format!("\"{token}\""))
            .map_err(|_| Error::IncompatibleStore)?;
        event.row.payload_json = body.with_text(token);
        if event.row.payload_json.len() != revision.payload_bytes {
            return Err(Error::IncompatibleStore);
        }
        base = Cow::Owned(event);
    }
    Ok((base.into_owned(), depth))
}

pub(super) async fn decode_row_or_revision(
    tx: &mut Transaction,
    catalog: &ApplicationCatalog,
    definition: &ApplicationTable,
    encoded_key: &[u8],
    bytes: &[u8],
) -> Result<ApplicationRow> {
    if let Ok(row) = decode_row(catalog, definition, encoded_key, bytes) {
        return Ok(row);
    }
    let (event, _) = restore(tx, catalog, definition, encoded_key, bytes, None).await?;
    Ok(event.stored())
}

pub(super) struct ReplayBase {
    event: EventRecord,
    depth: usize,
}

/// Keep one bounded base local to the immutable view of an ordered page.
pub(super) async fn read_for_replay(
    tx: &mut Transaction,
    catalog: &ApplicationCatalog,
    definition: &ApplicationTable,
    encoded_key: &[u8],
    bytes: &[u8],
    previous: &mut Option<ReplayBase>,
) -> Result<EventRecord> {
    let (event, depth) = match decode_row(catalog, definition, encoded_key, bytes) {
        Ok(row) => (EventRecord::from_row(row.row)?, 0),
        Err(_) => {
            restore(
                tx,
                catalog,
                definition,
                encoded_key,
                bytes,
                previous.as_ref(),
            )
            .await?
        }
    };
    *previous = (message_update(&event)
        && bytes.len() <= MAX_ROW_BYTES
        && event.row.payload_json.len() <= MAX_PAYLOAD_BYTES)
        .then(|| ReplayBase {
            event: event.clone(),
            depth,
        });
    Ok(event)
}

async fn encode_append(
    tx: &mut Transaction,
    catalog: &ApplicationCatalog,
    event: &EventRecord,
    current: TextPayload,
    head: &Head,
    mut stored: ApplicationRow,
    full_bytes: usize,
) -> Result<Option<Vec<u8>>> {
    let definition = table(catalog, EVENTS)?;
    let previous_key = event_key(catalog, head.event.sequence)?;
    let previous = tx
        .get(&previous_key)
        .await?
        .ok_or(Error::IncompatibleStore)?;
    if previous.len() > MAX_ROW_BYTES {
        return Err(Error::IncompatibleStore);
    }
    let (base, depth) = match decode_row(catalog, definition, &previous_key, &previous) {
        Ok(row) => (EventRecord::from_row(row.row)?, 0),
        Err(_) => restore(tx, catalog, definition, &previous_key, &previous, None).await?,
    };
    if EventRef::from(&base) != head.event
        || base.row.stream_id != head.thread_id
        || base.sequence >= event.sequence
        || base.stream_version >= event.stream_version
    {
        return Err(Error::IncompatibleStore);
    }
    let prev = TextPayload::parse(&base)?.ok_or(Error::IncompatibleStore)?;
    if prev.message_id != head.message_id {
        return Err(Error::IncompatibleStore);
    }
    if depth == MAX_CHAIN || !current.matches(&prev) || prev.text_token().is_empty() {
        return Ok(None);
    }
    let Some(suffix) = current.text_token().strip_prefix(prev.text_token()) else {
        return Ok(None);
    };
    if suffix.is_empty() || suffix.len() > MAX_SUFFIX_BYTES {
        return Ok(None);
    }
    let suffix = suffix.to_owned();
    stored.row.insert(
        "payload_json".into(),
        text_cell(&current.with_text(String::new())),
    );
    let compact = encode(&StoredRevision {
        row: stored,
        text_revision: TextRevision {
            previous: EventRef::from(&base),
            previous_text_bytes: prev.text_token().len(),
            payload_bytes: event.row.payload_json.len(),
            suffix,
        },
    })?;
    let dependency = dependent_key(catalog, base.sequence);
    let witness = encode(&EventRef::from(event))?;
    if compact.len() + dependency.len() + witness.len() >= full_bytes {
        return Ok(None);
    }
    if tx.get(&dependency).await?.is_some() {
        return Err(Error::IncompatibleStore);
    }
    tx.insert(dependency, witness).await?;
    Ok(Some(compact))
}

pub(super) async fn encode_event(
    tx: &mut Transaction,
    catalog: &ApplicationCatalog,
    event: &EventRecord,
    stored: ApplicationRow,
) -> Result<Vec<u8>> {
    let full = encode_row(&stored)?;
    if catalog.event_layout.is_none() || !message_update(event) || !valid_id(&event.row.stream_id) {
        return Ok(full);
    }
    let head = read_head(tx, catalog, &event.row.stream_id).await?;
    let key = head_key(catalog, &event.row.stream_id);
    let current = if full.len() <= MAX_ROW_BYTES {
        TextPayload::parse(event)?
    } else {
        None
    };
    let Some(current) = current else {
        if head.is_some() {
            tx.delete(key).await?;
        }
        return Ok(full);
    };
    let next = Head {
        thread_id: event.row.stream_id.clone(),
        message_id: current.message_id.clone(),
        event: EventRef::from(event),
    };
    let compact = if let Some(head) = head.filter(|head| head.message_id == current.message_id) {
        encode_append(tx, catalog, event, current, &head, stored, full.len()).await?
    } else {
        None
    };
    tx.put(key, encode(&next)?).await?;
    Ok(compact.unwrap_or(full))
}

pub(super) async fn before_delete(
    tx: &mut Transaction,
    catalog: &ApplicationCatalog,
    event: &EventRecord,
) -> Result<()> {
    if catalog.event_layout.is_none() || !message_update(event) || !valid_id(&event.row.stream_id) {
        return Ok(());
    }
    let definition = table(catalog, EVENTS)?;
    let encoded_key = event_key(catalog, event.sequence)?;
    let bytes = tx
        .get(&encoded_key)
        .await?
        .ok_or(Error::IncompatibleStore)?;
    let dependency = dependent_key(catalog, event.sequence);
    if let Some(witness) = tx.get(&dependency).await? {
        let child: EventRef = decode(&witness)?;
        let child_key = event_key(catalog, child.sequence)?;
        let bytes = tx.get(&child_key).await?.ok_or(Error::IncompatibleStore)?;
        let (stored_child, revision) = physical_revision(catalog, definition, &child_key, &bytes)?;
        if EventRef::from(&stored_child) != child || revision.previous != EventRef::from(event) {
            return Err(Error::IncompatibleStore);
        }
        let (restored, _) = restore(tx, catalog, definition, &child_key, &bytes, None).await?;
        tx.put(child_key, encode_row(&restored.stored())?).await?;
        tx.delete(dependency).await?;
    }
    if decode_row(catalog, definition, &encoded_key, &bytes).is_err() {
        let (_, revision) = physical_revision(catalog, definition, &encoded_key, &bytes)?;
        tx.delete(dependent_key(catalog, revision.previous.sequence))
            .await?;
    }
    if let Some(head) = read_head(tx, catalog, &event.row.stream_id).await?
        && head.event.sequence == event.sequence
    {
        if head.event != EventRef::from(event)
            || TextPayload::parse(event)?
                .is_none_or(|payload| payload.message_id != head.message_id)
        {
            return Err(Error::IncompatibleStore);
        }
        tx.delete(head_key(catalog, &event.row.stream_id)).await?;
    }
    Ok(())
}
