//! Bounded, read-only thread navigation. Each environment/thread owns its editor entities.
//! Hidden workspaces retain native text, directed selection, scroll and last editor focus.
use crate::{
    RecordedReply, SubmissionStatus, Workspace,
    server_snapshot::{self, Connection, ThreadRow},
};
use gpui::{
    AppContext, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_base::Button;
use std::collections::BTreeMap;

type DraftKey = (String, String);

pub struct ThreadWorkspace {
    connection: Option<Connection>,
    rows: Vec<ThreadRow>,
    selected: Option<DraftKey>,
    drafts: BTreeMap<DraftKey, Entity<Workspace>>,
    error: Option<&'static str>,
    _shell: Option<gpui::Task<()>>,
}

impl ThreadWorkspace {
    pub fn new(
        connection: Result<Connection, &'static str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut result = Self {
            connection: connection.ok(),
            rows: Vec::new(),
            selected: None,
            drafts: BTreeMap::new(),
            error: None,
            _shell: None,
        };
        let Some(connection) = result.connection.clone() else {
            result.error = Some(server_snapshot::FAILED);
            return result;
        };
        let initial = connection.thread_id().to_owned();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        cx.background_executor()
            .spawn(async move {
                let _ = sender.send(connection.threads());
            })
            .detach();
        let executor = cx.background_executor().clone();
        result._shell = Some(cx.spawn_in(window, async move |view, cx| {
            loop {
                match receiver.try_recv() {
                    Ok(reply) => {
                        let _ = view.update_in(cx, |view, window, cx| {
                            match reply {
                                Ok(rows) if rows.iter().any(|row| row.id == initial) => {
                                    view.rows = rows;
                                    view.select(&initial, window, cx);
                                }
                                _ => view.error = Some(server_snapshot::FAILED),
                            }
                            cx.notify();
                        });
                        break;
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                        executor.timer(std::time::Duration::from_millis(16)).await
                    }
                }
            }
        }));
        result
    }

    fn select(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if !self.rows.iter().any(|row| row.id == id) {
            return;
        }
        let Some(connection) = &self.connection else {
            return;
        };
        let key = (connection.environment_id().to_owned(), id.to_owned());
        if self.selected.as_ref() == Some(&key) {
            return;
        }
        let connection = connection.for_thread(id);
        let workspace = self
            .drafts
            .entry(key.clone())
            .or_insert_with(|| {
                cx.new(|cx| {
                    let mut workspace = Workspace::new(window, cx);
                    workspace.read_only = true;
                    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                    cx.background_executor()
                        .spawn(async move {
                            let _ =
                                sender.send(connection.snapshot(
                                    super::server_snapshot::SnapshotFormat::WithMessageIds,
                                ));
                        })
                        .detach();
                    let executor = cx.background_executor().clone();
                    // Receiver ownership is the fence: no completion can address the navigator's
                    // selected entity. A late A reply updates A even after A -> B -> A.
                    workspace._submission = Some(cx.spawn_in(window, async move |owner, cx| {
                        loop {
                            match receiver.try_recv() {
                                Ok(reply) => {
                                    let _ = owner.update_in(cx, |owner, window, cx| {
                                        match reply {
                                            Ok(snapshot) => owner.set_reply(
                                                snapshot.text,
                                                server_snapshot::LABEL,
                                                window,
                                                cx,
                                            ),
                                            Err(error) => {
                                                owner.status =
                                                    Some(SubmissionStatus::Refused(error))
                                            }
                                        }
                                        cx.notify();
                                    });
                                    break;
                                }
                                Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                                Err(std::sync::mpsc::TryRecvError::Empty) => {
                                    executor.timer(std::time::Duration::from_millis(16)).await
                                }
                            }
                        }
                    }));
                    workspace
                })
            })
            .clone();
        self.selected = Some(key);
        workspace.update(cx, |workspace, cx| {
            let editor = if workspace.reply_focused {
                workspace
                    .reply
                    .as_ref()
                    .map(|RecordedReply { editor, .. }| editor)
                    .unwrap_or(&workspace.composer)
            } else {
                &workspace.composer
            };
            editor.update(cx, |state, cx| state.focus(window, cx));
        });
        cx.notify();
    }
}

impl Render for ThreadWorkspace {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut controls = div().flex().flex_wrap().gap_2().p_2();
        for (index, row) in self.rows.iter().enumerate() {
            let id = row.id.clone();
            let label = format!("Open thread {}", row.id);
            controls = controls.child(
                Button::new(("select-thread", index))
                    .accessibility_label(label)
                    .child(row.title.clone())
                    .on_click(cx.listener(move |view, _, window, cx| view.select(&id, window, cx))),
            );
        }
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(controls)
            .when_some(self.error, |view, error| view.child(error))
            .when_some(
                self.selected
                    .as_ref()
                    .and_then(|key| self.drafts.get(key))
                    .cloned(),
                |view, workspace| view.child(div().flex_1().min_h(px(0.)).child(workspace)),
            )
    }
}
