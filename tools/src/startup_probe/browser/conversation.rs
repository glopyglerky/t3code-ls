use super::Browser;
use crate::Result;
use serde_json::{Value, json};
use std::path::Path;

const PROMPT: &str = "Replay the plan and reads fixture.";

impl Browser {
    pub(in crate::startup_probe) fn conversation(
        &self,
        workspace: &Path,
        scoped_j06: bool,
        attribution: bool,
    ) -> Result<Value> {
        let status = self.command(
            "POST",
            "/execute/async",
            Some(json!({
                "script": r#"
                    const [workspaceRoot, done] = arguments;
                    fetch('/api/projects/mutate', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json', 'x-t3-orchestration-protocol': '2'},
                        body: JSON.stringify({
                            type: 'project.create', projectId: 'conversation-fixture',
                            commandId: 'conversation-fixture-create', title: 'conversation-fixture',
                            workspaceRoot
                        })
                    }).then(response => done(response.status), () => done(0));
                "#,
                "args": [workspace],
            })),
        )?;
        if !status
            .as_u64()
            .is_some_and(|status| (200..300).contains(&status))
        {
            return Err(format!("fixture project creation returned HTTP {status}").into());
        }
        self.click_when(
            "the fixture project's New thread control",
            r#"return document.querySelector('button[aria-label="New thread in conversation-fixture"]');"#,
        )?;
        self.click_when(
            "the draft model picker",
            "return [...document.querySelectorAll('[data-chat-provider-model-picker=true]')].find(e => e.getClientRects().length);",
        )?;
        self.type_when(
            "model search",
            r#"return document.querySelector('input[placeholder="Search models..."]');"#,
            "Plan and reads",
        )?;
        self.click_when(
            "Plan and reads model",
            "return [...document.querySelectorAll('[role=option]')].find(e => e.textContent.includes('Plan and reads') && e.getClientRects().length);",
        )?;
        let search = self.script(
            r#"return [...document.querySelectorAll('input[placeholder="Search models..."]')].find(e => e.getClientRects().length);"#,
        )?;
        if let Some(element) = search[super::ELEMENT].as_str() {
            self.command(
                "POST",
                &format!("/element/{element}/value"),
                Some(json!({"text": "\u{e00c}"})),
            )?;
        }
        self.type_when(
            "the draft composer",
            "return document.querySelector('[data-testid=composer-editor][contenteditable=true]');",
            PROMPT,
        )?;
        if scoped_j06 {
            self.script_with_args(
                include_str!("conversation-accept.js"),
                json!([PROMPT, attribution]),
            )?;
        }
        self.script(include_str!("conversation-timing.js"))?;
        self.click_when(
            "Submit message",
            r#"return [...document.querySelectorAll('button[aria-label="Submit message"]')].find(e => !e.disabled && e.getClientRects().length);"#,
        )?;
        self.wait_for("the recorded turn's terminal text", || {
            self.script("return window.fixtureConversationTiming?.terminalMillis > 0;")
                .map(|value| value == true)
        })?;
        let timing = self.script("return window.fixtureConversationTiming;")?;
        let first = timing["firstVisibleMillis"].as_f64().unwrap_or_default();
        let terminal = timing["terminalMillis"].as_f64().unwrap_or_default();
        if first <= 0.0 || terminal <= first {
            return Err(
                "the recorded reply did not render in distinct streaming and terminal frames"
                    .into(),
            );
        }
        let acceptance = if scoped_j06 {
            self.wait_for("the matching launch acknowledgement", || {
                self.script("return !!window.fixtureConversationAccept?.result || !!window.fixtureConversationAccept?.error;")
                    .map(|value| value == true)
            })?;
            let accept = self.script(
                "window.fixtureConversationAccept.stop(); return window.fixtureConversationAccept;",
            )?;
            if !accept["error"].is_null() || accept["result"]["sequence"].as_u64().unwrap_or(0) == 0
            {
                return Err("missing or invalid command-specific launch acknowledgement".into());
            }
            accept
        } else {
            Value::Null
        };
        let snapshot = self.command(
            "POST",
            "/execute/async",
            Some(json!({
                "script": include_str!("conversation-snapshot.js"),
                "args": [PROMPT],
            })),
        )?;
        if snapshot["valid"] != true {
            return Err("authoritative snapshot did not contain one completed fixture turn".into());
        }
        if !scoped_j06 {
            return Ok(json!({"timing": timing, "snapshot": snapshot}));
        }
        let stored = self.stored_fixture(&acceptance)?;
        let route = self.script("return location.href;")?;
        let reopen_started = std::time::Instant::now();
        self.command("POST", "/refresh", Some(json!({})))?;
        self.wait_for("the reopened completed fixture", || {
            self.script("const text = document.querySelector('main, [role=main]')?.innerText ?? ''; return text.includes('todo list fixture complete') && !document.querySelector('button[aria-label=\"Stop generation\"]');")
                .map(|value| value == true)
        })?;
        let reopen_micros = reopen_started.elapsed().as_micros();
        if self.script("return location.href;")? != route {
            return Err("reopen changed the fixture route".into());
        }
        let reopened = self.stored_fixture(&acceptance)?;
        if stored != reopened {
            return Err("reopened authoritative fixture work changed".into());
        }
        let submit = timing["submitEpochMillis"]
            .as_f64()
            .ok_or("missing submit timestamp")?;
        let arrived = acceptance["result"]["ackEpochMillis"]
            .as_f64()
            .ok_or("missing acknowledgement timestamp")?;
        if arrived <= submit {
            return Err("launch acknowledgement precedes submit".into());
        }
        Ok(
            json!({"timing": timing, "snapshot": snapshot, "acceptance": acceptance,
            "submit_to_accept_ack_millis": arrived - submit,
            "stored_work": stored, "reopened_work": reopened,
            "browser_reload_micros": reopen_micros}),
        )
    }

    fn stored_fixture(&self, acceptance: &Value) -> Result<Value> {
        let snapshot = self.command(
            "POST",
            "/execute/async",
            Some(json!({
                "script": include_str!("conversation-stored-work.js"),
                "args": [PROMPT, acceptance["result"]],
            })),
        )?;
        if snapshot["valid"] != true {
            return Err("command identity or exact stored fixture work mismatch".into());
        }
        Ok(snapshot["work"].clone())
    }

    fn click_when(&self, label: &str, selector: &str) -> Result<()> {
        let element = self.wait_element(label, selector)?;
        self.command(
            "POST",
            &format!("/element/{element}/click"),
            Some(json!({})),
        )?;
        Ok(())
    }

    fn type_when(&self, label: &str, selector: &str, text: &str) -> Result<()> {
        let element = self.wait_element(label, selector)?;
        self.command(
            "POST",
            &format!("/element/{element}/value"),
            Some(json!({"text": text})),
        )?;
        Ok(())
    }
}
