use super::*;

pub(super) struct Proof {
    ticks: Timer,
    deadline: Timer,
}

impl Proof {
    pub(super) fn start(cx: &mut Cx) -> Self {
        Self {
            ticks: cx.start_interval(0.08),
            deadline: cx.start_timeout(10.0),
        }
    }

    pub(super) fn advance(&mut self, app: &mut App, cx: &mut Cx, event: &Event) {
        assert!(
            self.deadline.is_event(event).is_none(),
            "Makepad snapshot proof timed out"
        );
        if self.ticks.is_event(event).is_none()
            || app.ui.text_input(cx, ids!(composer)).area().is_empty()
        {
            return;
        }
        let expected = crate::SNAPSHOT
            .get()
            .expect("Snapshot mode was not selected");
        let label = app.ui.label(cx, ids!(snapshot));
        assert!(app.ui.label(cx, ids!(snapshot_heading)).text() == crate::server_snapshot::LABEL);
        match expected {
            Ok(snapshot) => {
                // Keep assertion failures free of conversation contents.
                assert!(
                    label.text() == snapshot.text,
                    "Snapshot widget did not retain the selected text"
                );
                let prompt = snapshot
                    .text
                    .find("GPUI saved conversation prompt")
                    .expect("Missing synthetic prompt");
                let reply = snapshot
                    .text
                    .find("GPUI server reply café 🦀")
                    .expect("Missing synthetic reply");
                assert!(prompt < reply, "Synthetic message order changed");
                assert!(
                    snapshot
                        .text
                        .contains("Thread import:codex:0251af00-0000-4000-8000-000000000035\n"),
                    "Wrong synthetic thread"
                );
                println!("T14 Makepad server snapshot proof passed");
            }
            Err(_) => {
                assert!(
                    label.text() == crate::server_snapshot::FAILED,
                    "Missing safe refusal"
                );
                println!("T14 Makepad server snapshot refusal passed");
            }
        }
        cx.stop_timer(self.ticks);
        cx.stop_timer(self.deadline);
        cx.quit();
    }
}
