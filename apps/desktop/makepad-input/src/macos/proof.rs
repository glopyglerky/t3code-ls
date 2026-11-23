use super::*;
use t3_code_ls_client_text::composer_draft::DraftSelection;
use t3_code_ls_client_text::text_revision::Utf16Offset;

const INITIAL: &str = "日🐟e\u{301}";
const REVERSE_SELECTION: DraftSelection = DraftSelection {
    anchor: Utf16Offset(5),
    head: Utf16Offset(1),
};

pub(super) struct Proof {
    ticks: Timer,
    deadline: Timer,
    step: u8,
}

impl Proof {
    pub(super) fn start(cx: &mut Cx) -> Self {
        Self {
            ticks: cx.start_interval(0.08),
            deadline: cx.start_timeout(10.0),
            step: 0,
        }
    }

    pub(super) fn advance(&mut self, app: &mut App, cx: &mut Cx, event: &Event) {
        assert!(
            self.deadline.is_event(event).is_none(),
            "Makepad input proof timed out at step {}",
            self.step
        );
        if self.ticks.is_event(event).is_none() {
            return;
        }

        let input = app.ui.text_input(cx, ids!(composer));
        let status = app.ui.label(cx, ids!(status));
        match self.step {
            0 => {
                if input.area().is_empty() {
                    return;
                }
                input.take_key_focus(cx);
            }
            1 => {
                assert!(cx.has_key_focus(input.area()));
                submit(app, cx);
            }
            2 => {
                assert_eq!(status.text(), "Enter a draft before submitting.");
                assert!(cx.has_key_focus(input.area()));
                type_text(app, cx, INITIAL, false);
                assert_eq!(app.draft.text(), INITIAL);
                for _ in 0..2 {
                    app.dispatch(
                        cx,
                        &Event::KeyDown(KeyEvent {
                            key_code: KeyCode::ArrowLeft,
                            modifiers: KeyModifiers {
                                shift: true,
                                ..Default::default()
                            },
                            ..Default::default()
                        }),
                    );
                }
                assert_eq!(input.selected_text(), "🐟e\u{301}");
                assert_eq!(app.draft.selection(), REVERSE_SELECTION);
                type_text(app, cx, "に", true);
                type_text(app, cx, "にほ", true);
                assert!(input.is_composing());
                assert_eq!(input.text(), "日にほ");
                assert_eq!(app.draft.text(), INITIAL);
                submit(app, cx);
            }
            3 => {
                assert_eq!(status.text(), "Finish composing before submitting.");
                assert!(input.is_composing());
                type_text(app, cx, "", true);
                assert!(!input.is_composing());
                assert_eq!(input.text(), INITIAL);
                assert_eq!(app.draft.selection(), REVERSE_SELECTION);
                type_text(app, cx, "ご", true);
                type_text(app, cx, "語", false);
                assert!(!input.is_composing());
                assert_eq!(app.draft.text(), "日語");
                assert_eq!(app.draft.selection().head, Utf16Offset(2));
                type_text(app, cx, " ש👩‍💻", false);
                assert_eq!(app.draft.text(), "日語 ש👩‍💻");
                assert_eq!(app.draft.selection().head, Utf16Offset(9));
                type_text(app, cx, "あ", true);
                cx.set_key_focus(Area::Empty);
            }
            4 => {
                assert!(!cx.has_key_focus(input.area()));
                assert!(!input.is_composing());
                type_text(app, cx, "余分", false);
                assert_eq!(input.text(), "日語 ש👩‍💻");
                assert_eq!(app.draft.text(), input.text());
                input.take_key_focus(cx);
            }
            5 => {
                assert!(cx.has_key_focus(input.area()));
                submit(app, cx);
            }
            6 => {
                assert_eq!(status.text(), "Submitted 20 UTF-8 bytes locally.");
                assert_eq!(app.draft.submit(), Ok("日語 ש👩‍💻"));
                assert!(cx.has_key_focus(input.area()));
                assert!(input.cursor_rect_in_absolute(cx).is_some());
                println!(
                    "T01 Makepad input proof passed: edit, selection, preedit, cancel, commit, blur, refocus, submit and refusal"
                );
                cx.stop_timer(self.ticks);
                cx.stop_timer(self.deadline);
                cx.quit();
            }
            _ => unreachable!(),
        }
        self.step += 1;
    }
}

fn type_text(app: &mut App, cx: &mut Cx, text: &str, replace_last: bool) {
    app.dispatch(
        cx,
        &Event::TextInput(TextInputEvent {
            input: text.to_owned(),
            replace_last,
            ..Default::default()
        }),
    );
}

fn submit(app: &mut App, cx: &mut Cx) {
    app.dispatch(
        cx,
        &Event::KeyDown(KeyEvent {
            key_code: KeyCode::ReturnKey,
            modifiers: KeyModifiers {
                logo: true,
                ..Default::default()
            },
            ..Default::default()
        }),
    );
}
