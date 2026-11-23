mod history_view;
mod replay;
#[path = "../../../../packages/client-runtime/rust/host/server_snapshot.rs"]
mod server_snapshot;
mod server_submit;

use std::{
    ffi::OsStr,
    process::ExitCode,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use gpui::{
    App, AppContext, Bounds, Context, Entity, EntityInputHandler, Focusable, InteractiveElement,
    IntoElement, KeyBinding, ParentElement, QuitMode, Render, Role, StatefulInteractiveElement,
    Styled, Subscription, Window, WindowBounds, WindowOptions, actions, div,
    prelude::FluentBuilder as _, px, rgb, size,
};
use gpui_base::{
    Button, Root,
    input::{InputAccessibility, InputEvent, Textarea, TextareaState},
};

actions!(fixture_workspace, [FocusNext, FocusPrevious]);

const WORKSPACE_CONTEXT: &str = "ShowcaseWorkspace";
const TEXTAREA_CONTEXT: &str = "ShowcaseWorkspace > Input";
const COMPOSER_LABEL: &str = "Message";
const SUBMIT_LABEL: &str = "Submit message";
const STOP_LABEL: &str = "Stop";
const APPROVAL_LABEL: &str = "Allow once";
const REPLY_LABEL: &str = "Recorded assistant reply";
const USAGE: &str = "Usage: t3-code-ls-desktop-gpui --fixture showcase | --thread-snapshot | --thread-compose | --thread-history < CONNECTION_JSON";
const SHORTCUT: &str = if cfg!(target_os = "macos") {
    "Command+Enter"
} else {
    "Ctrl+Enter"
};

enum ServerUpdate {
    Partial(server_snapshot::Snapshot),
    Finished(Result<server_submit::Progress, &'static str>),
}

enum SubmissionStatus {
    Pending,
    AwaitingApproval {
        approval: server_submit::Approval,
        submitted: String,
    },
    Responding,
    Completed,
    Refused(&'static str),
}

struct Workspace {
    composer: Entity<TextareaState>,
    reply: Option<RecordedReply>,
    status: Option<SubmissionStatus>,
    _composer_events: Subscription,
    server: Option<Arc<server_submit::Session>>,
    server_attempted: bool,
    stop_requested: bool,
    cancelled: Arc<AtomicBool>,
    _submission: Option<gpui::Task<()>>,
}

struct RecordedReply {
    editor: Entity<TextareaState>,
    _focus_events: Subscription,
}

impl Workspace {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::new_with_server(None, window, cx)
    }

    fn new_with_server(
        server: Option<server_submit::Session>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let placeholder = if server.is_some() {
            "Message for selected thread"
        } else {
            replay::PROMPT
        };
        let composer = cx.new(|cx| {
            let mut state = TextareaState::new(window, cx)
                .rows(4)
                .placeholder(placeholder)
                .context_menu(false);
            state.set_accessibility(
                InputAccessibility::new(Some(Role::MultilineTextInput))
                    .with_label(Some(COMPOSER_LABEL.into()))
                    .with_placeholder(Some(placeholder.into()))
                    .with_accessibility_id(Some("fixture-compose".into())),
            );
            state.focus(window, cx);
            state
        });
        let composer_events = cx.subscribe_in(
            &composer,
            window,
            |workspace, _, event, window, cx| match event {
                InputEvent::PressEnter {
                    secondary: true,
                    shift: false,
                } => workspace.submit(window, cx),
                InputEvent::Focus | InputEvent::Blur => cx.notify(),
                InputEvent::Change
                    if matches!(workspace.status, Some(SubmissionStatus::Refused(_)))
                        && !workspace.server_attempted =>
                {
                    workspace.status = None;
                    cx.notify();
                }
                _ => {}
            },
        );
        Self {
            composer,
            reply: None,
            status: None,
            _composer_events: composer_events,
            server: server.map(Arc::new),
            server_attempted: false,
            stop_requested: false,
            cancelled: Arc::new(AtomicBool::new(false)),
            _submission: None,
        }
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let draft = self.composer.update(cx, |state, cx| {
            state
                .marked_text_range(window, cx)
                .is_none()
                .then(|| state.value())
        });
        let Some(draft) = draft else {
            self.status = Some(SubmissionStatus::Refused(
                "Finish composing text before submitting.",
            ));
            cx.notify();
            return;
        };

        if let Some(server) = &self.server {
            if self.server_attempted {
                return;
            }
            if draft.trim().is_empty() || draft.len() > 4096 {
                self.status = Some(SubmissionStatus::Refused(
                    "Enter a message of at most 4096 UTF-8 bytes.",
                ));
                cx.notify();
                return;
            }
            self.server_attempted = true;
            self.status = Some(SubmissionStatus::Pending);
            let server = Arc::clone(server);
            let cancelled = Arc::clone(&self.cancelled);
            let submitted = draft.to_string();
            let request = submitted.clone();
            let (sender, receiver) = std::sync::mpsc::sync_channel(4);
            cx.background_executor()
                .spawn(async move {
                    let result = server.submit_streaming(&request, &cancelled, &mut |snapshot| {
                        sender
                            .send(ServerUpdate::Partial(snapshot))
                            .map_err(|_| server_submit::FAILED)
                    });
                    let _ = sender.send(ServerUpdate::Finished(result));
                })
                .detach();
            self.receive_updates(receiver, submitted, window, cx);
            cx.notify();
            return;
        }
        match replay::submit(draft.as_ref()) {
            Ok(reply) => {
                self.set_reply(reply.to_owned(), REPLY_LABEL, window, cx);
                self.composer
                    .update(cx, |state, cx| state.set_value("", window, cx));
                self.status = Some(SubmissionStatus::Completed);
            }
            Err(error) => self.status = Some(SubmissionStatus::Refused(error.message())),
        }
        self.composer
            .update(cx, |state, cx| state.focus(window, cx));
        cx.notify();
    }

    fn stop(&mut self, cx: &mut Context<Self>) {
        if matches!(self.status, Some(SubmissionStatus::Pending))
            && self
                .server
                .as_ref()
                .is_some_and(|server| server.request_stop())
        {
            self.stop_requested = true;
            cx.notify();
        }
    }

    fn allow_once(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(server) = self.server.as_ref().map(Arc::clone) else {
            return;
        };
        let Some(SubmissionStatus::AwaitingApproval {
            approval,
            submitted,
        }) = self
            .status
            .take_if(|status| matches!(status, SubmissionStatus::AwaitingApproval { .. }))
        else {
            return;
        };
        self.status = Some(SubmissionStatus::Responding);
        let cancelled = Arc::clone(&self.cancelled);
        let request = submitted.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(4);
        cx.background_executor()
            .spawn(async move {
                let result = server
                    .allow_once_streaming(&approval, &request, &cancelled, &mut |snapshot| {
                        sender
                            .send(ServerUpdate::Partial(snapshot))
                            .map_err(|_| server_submit::APPROVAL_UNCONFIRMED)
                    })
                    .map(server_submit::Progress::Completed)
                    .map_err(|_| server_submit::APPROVAL_UNCONFIRMED);
                let _ = sender.send(ServerUpdate::Finished(result));
            })
            .detach();
        self.receive_updates(receiver, submitted, window, cx);
        cx.notify();
    }

    fn receive_updates(
        &mut self,
        receiver: std::sync::mpsc::Receiver<ServerUpdate>,
        submitted: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let executor = cx.background_executor().clone();
        self._submission = Some(cx.spawn_in(window, async move |workspace, cx| {
            loop {
                match receiver.try_recv() {
                    Ok(ServerUpdate::Partial(snapshot)) => {
                        if workspace
                            .update_in(cx, |workspace, window, cx| {
                                workspace.set_reply(
                                    snapshot.text,
                                    server_snapshot::LABEL,
                                    window,
                                    cx,
                                );
                                cx.notify();
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(ServerUpdate::Finished(result)) => {
                        let _ = workspace.update_in(cx, |workspace, window, cx| match result {
                            Ok(server_submit::Progress::Approval(approval)) => {
                                workspace.status = Some(SubmissionStatus::AwaitingApproval {
                                    approval,
                                    submitted,
                                });
                                cx.notify();
                            }
                            Ok(server_submit::Progress::Interrupted(snapshot)) => {
                                workspace.set_reply(
                                    snapshot.text,
                                    server_snapshot::LABEL,
                                    window,
                                    cx,
                                );
                                workspace.status =
                                    Some(SubmissionStatus::Refused(server_submit::INTERRUPTED));
                                workspace
                                    .composer
                                    .update(cx, |state, cx| state.focus(window, cx));
                                cx.notify();
                            }
                            Ok(server_submit::Progress::Completed(snapshot)) => {
                                workspace.finish_submission(Ok(snapshot), &submitted, window, cx)
                            }
                            Err(error) => {
                                workspace.finish_submission(Err(error), &submitted, window, cx)
                            }
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
    }

    fn finish_submission(
        &mut self,
        result: Result<server_snapshot::Snapshot, &'static str>,
        submitted: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.status = Some(match result {
            Ok(snapshot) => {
                self.set_reply(snapshot.text, server_snapshot::LABEL, window, cx);
                self.composer.update(cx, |state, cx| {
                    if state.marked_text_range(window, cx).is_none()
                        && state.value().as_ref() == submitted
                    {
                        state.set_value("", window, cx);
                    }
                });
                SubmissionStatus::Completed
            }
            Err(message) => SubmissionStatus::Refused(message),
        });
        self.composer
            .update(cx, |state, cx| state.focus(window, cx));
        cx.notify();
    }

    fn set_reply(
        &mut self,
        reply: String,
        label: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(recorded) = &self.reply {
            recorded
                .editor
                .update(cx, |state, cx| state.set_value(reply, window, cx));
            return;
        }
        let editor = cx.new(|cx| {
            let mut state = TextareaState::new(window, cx)
                .rows(6)
                .default_value(reply)
                .context_menu(false);
            state.set_accessibility(
                InputAccessibility::new(Some(Role::Document))
                    .with_label(Some(label.into()))
                    .with_accessibility_id(Some("fixture-reply".into())),
            );
            state.set_readonly(true, cx);
            state
        });
        let focus_events = cx.subscribe_in(&editor, window, |_, _, event, _, cx| {
            if matches!(event, InputEvent::Focus | InputEvent::Blur) {
                cx.notify();
            }
        });
        self.reply = Some(RecordedReply {
            editor,
            _focus_events: focus_events,
        });
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let composer_focused = self.composer.read(cx).focus_handle(cx).is_focused(window);
        let approval = match &self.status {
            Some(SubmissionStatus::AwaitingApproval { approval, .. }) => Some(approval),
            _ => None,
        };
        let (status, status_color) = match &self.status {
            Some(SubmissionStatus::Pending) if self.stop_requested => {
                (server_submit::STOP_PENDING, 0x49596a)
            }
            Some(SubmissionStatus::Pending) => ("Submitting to the selected thread…", 0x49596a),
            Some(SubmissionStatus::AwaitingApproval { .. }) => {
                ("Command permission requested.", 0x49596a)
            }
            Some(SubmissionStatus::Responding) => {
                ("Confirming approval and turn completion…", 0x49596a)
            }
            Some(SubmissionStatus::Completed) if self.server.is_some() => {
                (server_submit::CONFIRMED, 0x126647)
            }
            Some(SubmissionStatus::Completed) => ("Recorded reply loaded.", 0x126647),
            Some(SubmissionStatus::Refused(message)) => (*message, 0xa32726),
            None if self.server.is_some() => ("Submit to the selected server thread.", 0x49596a),
            None => (
                "Only the recorded showcase runs in this workspace.",
                0x49596a,
            ),
        };

        let title = if self.server.is_some() {
            "Server conversation"
        } else {
            "hybrid-fixture"
        };
        div()
            .id("fixture-workspace")
            .role(Role::Main)
            .key_context(WORKSPACE_CONTEXT)
            .on_action(|_: &FocusNext, window, cx| window.focus_next(cx))
            .on_action(|_: &FocusPrevious, window, cx| window.focus_prev(cx))
            .size_full()
            .overflow_y_scroll()
            .bg(rgb(0xf3f5f7))
            .text_color(rgb(0x16212d))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .mx_auto()
                    .w_full()
                    .max_w(px(860.))
                    .p_6()
                    .gap_4()
                    .child(
                        div()
                            .id("workspace-title")
                            .role(Role::Heading)
                            .aria_level(1)
                            .aria_label(title)
                            .text_2xl()
                            .child(title),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_2()
                            .child(COMPOSER_LABEL)
                            .child(
                                div()
                                    .id("composer-field")
                                    .border_2()
                                    .border_color(rgb(if composer_focused {
                                        0x225cb4
                                    } else {
                                        0x9ea9b6
                                    }))
                                    .rounded_md()
                                    .bg(rgb(0xffffff))
                                    .p_2()
                                    .h(px(120.))
                                    .child(Textarea::new(&self.composer)),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_3()
                                    .child(
                                        Button::new("submit-message")
                                            .disabled(
                                                self.server.is_some() && self.server_attempted,
                                            )
                                            .accessibility_label(SUBMIT_LABEL)
                                            .border_2()
                                            .border_color(rgb(0x174887))
                                            .focus(|style| style.border_color(rgb(0xfdd166)))
                                            .rounded_md()
                                            .bg(rgb(0x174887))
                                            .text_color(rgb(0xffffff))
                                            .px_4()
                                            .py_2()
                                            .child(SUBMIT_LABEL)
                                            .on_click(cx.listener(|workspace, _, window, cx| {
                                                workspace.submit(window, cx);
                                            })),
                                    )
                                    .child(SHORTCUT)
                                    .when(
                                        self.server
                                            .as_ref()
                                            .is_some_and(|server| server.can_stop())
                                            && matches!(
                                                self.status,
                                                Some(SubmissionStatus::Pending)
                                            ),
                                        |view| {
                                            view.child(
                                                Button::new("stop-run")
                                                    .accessibility_label(STOP_LABEL)
                                                    .border_2()
                                                    .border_color(rgb(0x174887))
                                                    .focus(|style| {
                                                        style.border_color(rgb(0xfdd166))
                                                    })
                                                    .rounded_md()
                                                    .px_4()
                                                    .py_2()
                                                    .child(STOP_LABEL)
                                                    .on_click(cx.listener(
                                                        |workspace, _, _, cx| workspace.stop(cx),
                                                    )),
                                            )
                                        },
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .id("submission-status")
                            .role(Role::Status)
                            .aria_label(status)
                            .text_color(rgb(status_color))
                            .child(status),
                    )
                    .when_some(approval, |view, approval| {
                        let detail: gpui::SharedString = approval.detail.clone().into();
                        view.child(
                            div()
                                .flex()
                                .flex_col()
                                .items_start()
                                .gap_2()
                                .child(
                                    div()
                                        .id("server-approval-detail")
                                        .role(Role::Paragraph)
                                        .aria_label(detail.clone())
                                        .child(detail),
                                )
                                .child(
                                    Button::new("server-approval-allow-once")
                                        .accessibility_label(APPROVAL_LABEL)
                                        .border_2()
                                        .border_color(rgb(0x174887))
                                        .focus(|style| style.border_color(rgb(0xfdd166)))
                                        .rounded_md()
                                        .bg(rgb(0x174887))
                                        .text_color(rgb(0xffffff))
                                        .px_4()
                                        .py_2()
                                        .child(APPROVAL_LABEL)
                                        .on_click(cx.listener(|workspace, _, window, cx| {
                                            workspace.allow_once(window, cx);
                                        })),
                                ),
                        )
                    })
                    .when_some(self.reply.as_ref(), |view, reply| {
                        let focused = reply.editor.read(cx).focus_handle(cx).is_focused(window);
                        view.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .child(if self.server.is_some() {
                                    server_snapshot::LABEL
                                } else {
                                    REPLY_LABEL
                                })
                                .child(
                                    div()
                                        .id("reply-field")
                                        .border_2()
                                        .border_color(rgb(if focused {
                                            0x225cb4
                                        } else {
                                            0x9ea9b6
                                        }))
                                        .rounded_md()
                                        .bg(rgb(0xffffff))
                                        .p_2()
                                        .h(px(180.))
                                        .child(Textarea::new(&reply.editor)),
                                ),
                        )
                    }),
            )
    }
}

struct ServerThreadView {
    content: Option<Entity<TextareaState>>,
}

impl ServerThreadView {
    fn new(
        snapshot: Result<server_snapshot::Snapshot, &'static str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let content = snapshot.ok().map(|snapshot| {
            cx.new(|cx| {
                let mut state = TextareaState::new(window, cx)
                    .rows(18)
                    .default_value(snapshot.text)
                    .context_menu(false);
                state.set_accessibility(
                    InputAccessibility::new(Some(Role::Document))
                        .with_label(Some(server_snapshot::LABEL.into()))
                        .with_accessibility_id(Some("server-thread-snapshot".into())),
                );
                state.set_readonly(true, cx);
                state.focus(window, cx);
                state
            })
        });
        Self { content }
    }
}

impl Render for ServerThreadView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let mut view = div()
            .id("server-thread-view")
            .role(Role::Main)
            .size_full()
            .bg(rgb(0xf3f5f7))
            .text_color(rgb(0x16212d))
            .p_6()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                div()
                    .id("server-thread-heading")
                    .role(Role::Heading)
                    .aria_level(1)
                    .aria_label("Server conversation")
                    .text_2xl()
                    .child("Server conversation"),
            );
        if let Some(content) = &self.content {
            view = view.child(
                div()
                    .id("server-thread-document")
                    .h(px(490.))
                    .bg(rgb(0xffffff))
                    .border_2()
                    .border_color(rgb(0x9ea9b6))
                    .rounded_md()
                    .p_2()
                    .child(Textarea::new(content)),
            );
        } else {
            view = view.child(
                div()
                    .id("server-thread-status")
                    .role(Role::Status)
                    .aria_label(server_snapshot::FAILED)
                    .child(server_snapshot::FAILED),
            );
        }
        view
    }
}

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    if first.as_deref() == Some(OsStr::new("--help")) && args.next().is_none() {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    let mut server_session = None;
    let mut history_connection = None;
    let snapshot = if first.as_deref() == Some(OsStr::new("--thread-compose"))
        && args.next().is_none()
    {
        let Ok(session) = server_submit::Session::read(std::io::stdin().lock()) else {
            eprintln!("Invalid server connection input.");
            return ExitCode::from(2);
        };
        server_session = Some(session);
        None
    } else if first.as_deref() == Some(OsStr::new("--thread-history")) && args.next().is_none() {
        let Ok(connection) = server_snapshot::Connection::read(std::io::stdin().lock()) else {
            eprintln!("Invalid server connection input.");
            return ExitCode::from(2);
        };
        history_connection = Some(connection);
        None
    } else if first.as_deref() == Some(OsStr::new("--thread-snapshot")) && args.next().is_none() {
        Some(
            server_snapshot::Connection::read(std::io::stdin().lock()).and_then(|connection| {
                connection.snapshot(server_snapshot::SnapshotFormat::WithMessageIds)
            }),
        )
    } else if first.as_deref() == Some(OsStr::new("--fixture"))
        && args.next().as_deref() == Some(OsStr::new("showcase"))
        && args.next().is_none()
    {
        None
    } else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };

    let title = if history_connection.is_some() {
        "T3 Code · Saved conversation"
    } else if server_session.is_some() {
        "T3 Code · Server composer"
    } else if snapshot.is_some() {
        "T3 Code · Server conversation"
    } else {
        "T3 Code · Showcase fixture"
    };
    gpui_platform::application()
        .with_quit_mode(QuitMode::LastWindowClosed)
        .run(move |cx: &mut App| {
            gpui_base::init(cx);
            // The base textarea uses Tab to indent. In this form it moves focus.
            cx.bind_keys([
                KeyBinding::new("tab", FocusNext, Some(TEXTAREA_CONTEXT)),
                KeyBinding::new("shift-tab", FocusPrevious, Some(TEXTAREA_CONTEXT)),
            ]);
            let bounds = Bounds::centered(None, size(px(900.), px(640.)), cx);
            let result = cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(560.), px(480.))),
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some(title.into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                move |window, cx| {
                    if let Some(connection) = history_connection {
                        let workspace = cx.new(|cx| history_view::HistoryView::new(connection, window, cx));
                        cx.new(|cx| Root::new(workspace, window, cx))
                    } else if let Some(server) = server_session {
                        let workspace =
                            cx.new(|cx| Workspace::new_with_server(Some(server), window, cx));
                        cx.new(|cx| Root::new(workspace, window, cx))
                    } else if let Some(snapshot) = snapshot {
                        let workspace = cx.new(|cx| ServerThreadView::new(snapshot, window, cx));
                        cx.new(|cx| Root::new(workspace, window, cx))
                    } else {
                        let workspace = cx.new(|cx| Workspace::new(window, cx));
                        cx.new(|cx| Root::new(workspace, window, cx))
                    }
                },
            );
            match result {
                Ok(_) => cx.activate(true),
                Err(error) => {
                    eprintln!("Cannot open the GPUI fixture window: {error:#}");
                    std::process::exit(1);
                }
            }
        });
    ExitCode::SUCCESS
}
