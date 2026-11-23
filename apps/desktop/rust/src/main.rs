mod replay;

use std::{ffi::OsStr, process::ExitCode};

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
const REPLY_LABEL: &str = "Recorded assistant reply";
const USAGE: &str = "Usage: t3-code-ls-desktop-gpui --fixture showcase";
const SHORTCUT: &str = if cfg!(target_os = "macos") {
    "Command+Enter"
} else {
    "Ctrl+Enter"
};

struct Workspace {
    composer: Entity<TextareaState>,
    reply: Option<RecordedReply>,
    status: Option<Result<(), &'static str>>,
    _composer_events: Subscription,
}

struct RecordedReply {
    editor: Entity<TextareaState>,
    _focus_events: Subscription,
}

impl Workspace {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let composer = cx.new(|cx| {
            let mut state = TextareaState::new(window, cx)
                .rows(4)
                .placeholder(replay::PROMPT)
                .context_menu(false);
            state.set_accessibility(
                InputAccessibility::new(Some(Role::MultilineTextInput))
                    .with_label(Some(COMPOSER_LABEL.into()))
                    .with_placeholder(Some(replay::PROMPT.into()))
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
                InputEvent::Change if matches!(workspace.status, Some(Err(_))) => {
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
            self.status = Some(Err("Finish composing text before submitting."));
            cx.notify();
            return;
        };

        match replay::submit(draft.as_ref()) {
            Ok(reply) => {
                let editor = cx.new(|cx| {
                    let mut state = TextareaState::new(window, cx)
                        .rows(6)
                        .default_value(reply)
                        .context_menu(false);
                    state.set_accessibility(
                        InputAccessibility::new(Some(Role::Document))
                            .with_label(Some(REPLY_LABEL.into()))
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
                self.composer
                    .update(cx, |state, cx| state.set_value("", window, cx));
                self.status = Some(Ok(()));
            }
            Err(error) => self.status = Some(Err(error.message())),
        }
        self.composer
            .update(cx, |state, cx| state.focus(window, cx));
        cx.notify();
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let composer_focused = self.composer.read(cx).focus_handle(cx).is_focused(window);
        let (status, status_color) = match self.status {
            Some(Ok(())) => ("Recorded reply loaded.", 0x126647),
            Some(Err(message)) => (message, 0xa32726),
            None => (
                "Only the recorded showcase runs in this workspace.",
                0x49596a,
            ),
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
                            .aria_label("hybrid-fixture")
                            .text_2xl()
                            .child("hybrid-fixture"),
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
                                    .child(SHORTCUT),
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
                    .when_some(self.reply.as_ref(), |view, reply| {
                        let focused = reply.editor.read(cx).focus_handle(cx).is_focused(window);
                        view.child(
                            div().flex().flex_col().gap_2().child(REPLY_LABEL).child(
                                div()
                                    .id("reply-field")
                                    .border_2()
                                    .border_color(rgb(if focused { 0x225cb4 } else { 0x9ea9b6 }))
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

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    if first.as_deref() == Some(OsStr::new("--help")) && args.next().is_none() {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if first.as_deref() != Some(OsStr::new("--fixture"))
        || args.next().as_deref() != Some(OsStr::new("showcase"))
        || args.next().is_some()
    {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    }

    gpui_platform::application()
        .with_quit_mode(QuitMode::LastWindowClosed)
        .run(|cx: &mut App| {
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
                        title: Some("T3 Code · Showcase fixture".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |window, cx| {
                    let workspace = cx.new(|cx| Workspace::new(window, cx));
                    cx.new(|cx| Root::new(workspace, window, cx))
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
