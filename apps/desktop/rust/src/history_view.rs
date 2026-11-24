use super::*;
use server_snapshot::{Connection, History};

const LABEL: &str = "Saved thread history";
const LOAD: &str = "Load older";
const OPEN_FAILED: &str = "Could not read the selected server thread. Reopen to refresh.";

/// One selected connection, one in-flight page, and one persistent read-only editor.
pub(super) struct HistoryView {
    content: Entity<TextareaState>,
    history: Option<History>,
    pending: bool,
    status: String,
    cancelled: Arc<AtomicBool>,
    _request: Option<gpui::Task<()>>,
}

impl HistoryView {
    pub(super) fn new(connection: Connection, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let content = cx.new(|cx| {
            let mut state = TextareaState::new(window, cx).rows(18).context_menu(false);
            state.set_accessibility(
                InputAccessibility::new(Some(Role::Document))
                    .with_label(Some(LABEL.into()))
                    .with_accessibility_id(Some("saved-thread-history".into())),
            );
            state.set_readonly(true, cx);
            state.focus(window, cx);
            state
        });
        let mut view = Self {
            content,
            history: None,
            pending: false,
            status: String::new(),
            cancelled: Arc::new(AtomicBool::new(false)),
            _request: None,
        };
        view.request(move || connection.history(), OPEN_FAILED, window, cx);
        view
    }

    fn load_older(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending || !self.history.as_ref().is_some_and(History::has_older) {
            return;
        }
        let Some(mut history) = self.history.take() else {
            return;
        };
        self.request(
            move || {
                history.load_older()?;
                Ok(history)
            },
            server_snapshot::FAILED_HISTORY,
            window,
            cx,
        );
    }

    fn request(
        &mut self,
        operation: impl FnOnce() -> Result<History, &'static str> + Send + 'static,
        failure: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pending = true;
        self.status = "Loading saved history…".into();
        let cancelled = Arc::clone(&self.cancelled);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        cx.background_executor()
            .spawn(async move {
                if !cancelled.load(Ordering::Acquire) {
                    let result = operation();
                    if !cancelled.load(Ordering::Acquire) {
                        let _ = sender.send(result);
                    }
                }
            })
            .detach();
        let executor = cx.background_executor().clone();
        self._request = Some(cx.spawn_in(window, async move |view, cx| {
            loop {
                match receiver.try_recv() {
                    Ok(result) => {
                        let _ = view.update_in(cx, |view, window, cx| {
                            view.pending = false;
                            match result {
                                Ok(history) => {
                                    view.content.update(cx, |state, cx| {
                                        state.set_value(history.text().to_owned(), window, cx);
                                    });
                                    view.status = format!(
                                        "{} saved records loaded. {}",
                                        history.record_count(),
                                        if history.has_older() {
                                            "Load older for earlier records."
                                        } else {
                                            "All saved history loaded."
                                        }
                                    );
                                    view.history = Some(history);
                                }
                                Err(_) => {
                                    // The editor remains untouched and this view cannot retry.
                                    view.status = failure.into();
                                    view.history = None;
                                }
                            }
                            view.content.update(cx, |state, cx| state.focus(window, cx));
                            cx.notify();
                        });
                        break;
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        let _ = view.update_in(cx, |view, window, cx| {
                            view.pending = false;
                            view.history = None;
                            view.status = failure.into();
                            view.content.update(cx, |state, cx| state.focus(window, cx));
                            cx.notify();
                        });
                        break;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                        executor.timer(std::time::Duration::from_millis(16)).await;
                    }
                }
            }
        }));
        cx.notify();
    }
}

impl Drop for HistoryView {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

impl Render for HistoryView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let status: gpui::SharedString = self.status.clone().into();
        div()
            .id("saved-history-view")
            .role(Role::Main)
            .key_context(WORKSPACE_CONTEXT)
            .on_action(|_: &FocusNext, window, cx| window.focus_next(cx))
            .on_action(|_: &FocusPrevious, window, cx| window.focus_prev(cx))
            .size_full()
            .bg(rgb(0xf3f5f7))
            .text_color(rgb(0x16212d))
            .p_6()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                div()
                    .id("saved-history-heading")
                    .role(Role::Heading)
                    .aria_level(1)
                    .aria_label("Saved conversation")
                    .text_2xl()
                    .child("Saved conversation"),
            )
            .when(
                !self.pending && self.history.as_ref().is_some_and(History::has_older),
                |view| {
                    view.child(
                        Button::new("load-older-history")
                            .accessibility_label(LOAD)
                            .border_2()
                            .border_color(rgb(0x174887))
                            .focus(|style| style.border_color(rgb(0xfdd166)))
                            .rounded_md()
                            .px_4()
                            .py_2()
                            .child(LOAD)
                            .on_click(
                                cx.listener(|view, _, window, cx| view.load_older(window, cx)),
                            ),
                    )
                },
            )
            .child(
                div()
                    .id("history-status")
                    .role(Role::Status)
                    .aria_label(status.clone())
                    .child(status),
            )
            .child(
                div()
                    .id("history-document")
                    .flex_1()
                    .min_h(px(120.))
                    .bg(rgb(0xffffff))
                    .border_2()
                    .border_color(rgb(0x9ea9b6))
                    .rounded_md()
                    .p_2()
                    .child(Textarea::new(&self.content)),
            )
    }
}
