use super::Browser;
use crate::Result;
use serde_json::{Value, json};
use std::path::Path;

const PROMPT: &str = "Replay the plan and reads fixture.";

impl Browser {
    pub(in crate::startup_probe) fn conversation(&self, workspace: &Path) -> Result<Value> {
        self.click_when(
            "Add project",
            "return [...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'Add project' && !e.disabled && e.getClientRects().length);",
        )?;
        self.click_when(
            "Local folder",
            "return [...document.querySelectorAll('[role=dialog] *')].find(e => e.childElementCount === 0 && e.textContent.trim() === 'Local folder' && e.getClientRects().length);",
        )?;
        self.type_when(
            "the local folder path",
            "return document.querySelector('[role=dialog] input[role=combobox]');",
            workspace.to_str().ok_or("fixture path must be UTF-8")?,
        )?;
        self.click_when(
            "the enabled Add folder button",
            "return [...document.querySelectorAll('[role=dialog] button')].find(e => /^Add \\(/.test(e.textContent.trim()) && !e.disabled && e.getClientRects().length);",
        )?;
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
        Ok(json!({"timing": timing, "snapshot": snapshot}))
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
