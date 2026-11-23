use super::*;

pub(super) struct Proof {
    ticks: Timer,
    deadline: Timer,
    started: bool,
}

impl Proof {
    pub(super) fn start(cx: &mut Cx) -> Self {
        Self {
            ticks: cx.start_interval(0.08),
            deadline: cx.start_timeout(35.0),
            started: false,
        }
    }

    pub(super) fn advance(&mut self, app: &mut App, cx: &mut Cx, event: &Event) {
        assert!(
            self.deadline.is_event(event).is_none(),
            "Makepad history proof timed out"
        );
        if self.ticks.is_event(event).is_none()
            || app.ui.label(cx, ids!(snapshot)).area().is_empty()
        {
            return;
        }
        if app.history_pending.is_some() {
            return;
        }
        let label = app.ui.label(cx, ids!(snapshot));
        if let Some(history) = &app.history {
            assert!(
                label.text() == history.text(),
                "History widget does not match checked records"
            );
            if !self.started {
                assert!(
                    history.has_older() && history.record_count() < 80,
                    "Expected a bounded first page"
                );
                assert!(
                    !history.text().contains("\nuser\nGPUI history prompt 000\n"),
                    "Oldest history row was present on the first page"
                );
                self.started = true;
            }
            if history.has_older() {
                assert!(
                    !app.ui.button(cx, ids!(load_older)).area().is_empty(),
                    "Missing native history control"
                );
                // Invoke the same command used by the native button, without a physical-input claim.
                app.load_older(cx);
                return;
            }
            assert!(history.record_count() == 80, "Incomplete history");
            let mut position = 0;
            for turn in 0..40 {
                for (role, label) in [("user", "prompt"), ("assistant", "reply")] {
                    let expected = format!("\n{role}\nGPUI history {label} {turn:03}\n");
                    let found = history.text()[position..]
                        .find(&expected)
                        .expect("Missing ordered history record");
                    position += found + expected.len();
                }
            }
            println!("T14 Makepad server history proof passed");
        } else {
            assert!(
                label.text() == crate::server_snapshot::FAILED,
                "Missing safe history refusal"
            );
            println!("T14 Makepad server history refusal passed");
        }
        cx.stop_timer(self.ticks);
        cx.stop_timer(self.deadline);
        cx.quit();
    }
}
