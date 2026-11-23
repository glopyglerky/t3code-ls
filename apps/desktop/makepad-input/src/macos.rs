mod proof;
mod snapshot_proof;

use makepad_widgets::*;
use t3_code_ls_client_text::composer_draft::{ComposerDraft, DraftError};

const MAX_DRAFT_BYTES: usize = 4096;

app_main!(App);

pub fn launch() {
    main();
}

script_mod! {
    use mod.prelude.widgets.*

    let app = startup() do #(App::script_component(vm)) {
        ui: Root {
            Window {
                window.inner_size: vec2(640, 600)
                window.title: "T3 Code Makepad input"
                body +: {
                    flow: Down
                    padding: 20
                    spacing: 12
                    snapshot_heading := Label { width: Fill text: "" }
                    ScrollYView {
                        width: Fill
                        height: 220
                        snapshot := Label { width: Fill text: "" }
                    }
                    Label { text: "Synthetic local draft" }
                    composer := TextInput {
                        width: Fill
                        height: 145
                        is_multiline: true
                        keep_focus_on_submit: true
                        empty_text: "Type a draft"
                    }
                    submit := Button { text: "Submit locally" grab_key_focus: false }
                    status := Label { width: Fill text: "" }
                }
            }
        }
    }
    app
}

#[derive(Script, ScriptHook)]
struct App {
    #[live]
    ui: WidgetRef,
    #[rust(ComposerDraft::new(MAX_DRAFT_BYTES))]
    draft: ComposerDraft,
    #[rust]
    before_composition: Option<TextInputState>,
    #[rust]
    proof: Option<proof::Proof>,
    #[rust]
    snapshot_proof: Option<snapshot_proof::Proof>,
}

impl App {
    fn update_draft(&mut self, input: &TextInputRef) -> Result<(), DraftError> {
        let selection = input.selection();
        self.draft
            .update_committed(input.text(), selection.anchor.index, selection.cursor.index)
    }

    fn dispatch(&mut self, cx: &mut Cx, event: &Event) {
        let input = self.ui.text_input(cx, ids!(composer));
        let area = input.area();
        let text_event = match event {
            Event::TextInput(event) if !area.is_empty() && cx.has_key_focus(area) => Some(event),
            _ => None,
        };
        if text_event.is_some_and(|event| event.replace_last && !event.input.is_empty())
            && self.before_composition.is_none()
        {
            self.before_composition = Some(input.save_state());
        }

        self.ui.handle_event(cx, event, &mut Scope::empty());

        if input.is_composing() {
            return;
        }
        if let Some(previous) = self.before_composition.take()
            && !text_event.is_some_and(|event| !event.replace_last && !event.input.is_empty())
        {
            // The widget can lose its mark on blur without removing its preview.
            input.restore_state(cx, previous);
        }
        if matches!(
            event,
            Event::TextInput(_)
                | Event::TextRangeReplace(_)
                | Event::TextCut(_)
                | Event::KeyDown(_)
                | Event::KeyFocus(_)
                | Event::KeyFocusLost(_)
                | Event::MouseDown(_)
                | Event::MouseMove(_)
                | Event::MouseUp(_)
        ) {
            // Over-limit editor text stays editable. Submit validates the current
            // widget snapshot again before it can use the last accepted draft.
            let _ = self.update_draft(&input);
        }
    }
}

impl MatchEvent for App {
    fn handle_actions(&mut self, cx: &mut Cx, actions: &Actions) {
        let input = self.ui.text_input(cx, ids!(composer));
        if input.returned(actions).is_none() && !self.ui.button(cx, ids!(submit)).clicked(actions) {
            return;
        }
        if input.is_composing() {
            self.ui
                .label(cx, ids!(status))
                .set_text(cx, "Finish composing before submitting.");
            return;
        }
        let status = self.ui.label(cx, ids!(status));
        match self.update_draft(&input).and_then(|()| self.draft.submit()) {
            Ok(text) => {
                status.set_text(
                    cx,
                    &format!("Submitted {} UTF-8 bytes locally.", text.len()),
                );
            }
            Err(error) => {
                let message = match error {
                    DraftError::Empty => "Enter a draft before submitting.",
                    DraftError::TextLimit => "Drafts must fit in 4096 UTF-8 bytes.",
                    DraftError::InvalidSelection => "Could not read the draft selection.",
                };
                status.set_text(cx, message);
            }
        }
        input.take_key_focus(cx);
    }
}

impl AppMain for App {
    fn script_mod(vm: &mut ScriptVm) -> ScriptValue {
        makepad_widgets::script_mod(vm);
        self::script_mod(vm)
    }

    fn handle_event(&mut self, cx: &mut Cx, event: &Event) {
        if matches!(event, Event::Startup) {
            if std::env::args_os().any(|arg| arg == "--proof") {
                self.proof = Some(proof::Proof::start(cx));
            }
            if let Some(snapshot) = crate::SNAPSHOT.get() {
                self.ui
                    .label(cx, ids!(snapshot_heading))
                    .set_text(cx, crate::server_snapshot::LABEL);
                let text = match snapshot {
                    Ok(snapshot) => snapshot.text.as_str(),
                    Err(_) => crate::server_snapshot::FAILED,
                };
                self.ui.label(cx, ids!(snapshot)).set_text(cx, text);
                if std::env::args_os().any(|arg| arg == "--thread-snapshot-proof") {
                    self.snapshot_proof = Some(snapshot_proof::Proof::start(cx));
                }
            }
        }
        self.match_event(cx, event);
        self.dispatch(cx, event);
        if let Some(mut proof) = self.snapshot_proof.take() {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                proof.advance(self, cx, event);
            }))
            .is_err()
            {
                std::process::exit(1);
            }
            self.snapshot_proof = Some(proof);
        }
        if let Some(mut proof) = self.proof.take() {
            // AppKit contains callback panics. Make a failed proof exit instead
            // of leaving an interactive window open after an assertion fails.
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                proof.advance(self, cx, event);
            }))
            .is_err()
            {
                std::process::exit(1);
            }
            self.proof = Some(proof);
        }
    }
}
