use super::Browser;
use crate::Result;
use serde_json::{Value, json};
use std::path::Path;

impl Browser {
    pub(in crate::startup_probe) fn seed_reopen(
        &self,
        workspace: &Path,
        selected_thread: &str,
        thread_count: usize,
        message_count: usize,
    ) -> Result<(String, Value)> {
        self.command("POST", "/timeouts", Some(json!({"script": 120_000})))?;
        let imported = super::request(
            &self.origin,
            "POST",
            &format!("/session/{}/execute/async", self.session),
            Some(json!({
                "script": include_str!("reopen-seed.js"),
                "args": [workspace, thread_count, selected_thread],
            })),
            120,
        )?;
        self.command("POST", "/timeouts", Some(json!({"script": 5_000})))?;
        if imported["valid"] != true {
            return Err(format!("mature fixture import failed: {imported}").into());
        }
        let thread = self.wait_element(
            "the imported selected thread",
            "return [...document.querySelectorAll('[data-thread-item]')].find(e => e.textContent.includes('Reopen fixture 0000') && e.getClientRects().length);",
        )?;
        self.command("POST", &format!("/element/{thread}/click"), Some(json!({})))?;
        self.wait_for("the selected imported history", || {
            self.script("return document.querySelector('main, [role=main]')?.innerText.includes('Reopen fixture 0000 assistant 0199') === true;")
                .map(|value| value == true)
        })?;
        let location = self.script("return {path: location.pathname, threadId: decodeURIComponent(location.pathname.split('/').at(-1))};")?;
        let route = location["path"]
            .as_str()
            .ok_or("selected thread has no route")?
            .to_owned();
        if route.split('/').filter(|part| !part.is_empty()).count() != 2
            || location["threadId"] != selected_thread
        {
            return Err("the selected fixture thread did not own the visible route".into());
        }
        self.wait_for("durable shell and selected-thread browser caches", || {
            self.command("POST", "/execute/async", Some(json!({
                "script": r#"
                    const [threadId, done] = arguments;
                    const request = indexedDB.open('t3code:connection-runtime');
                    request.onerror = () => done(false);
                    request.onsuccess = () => {
                      const db = request.result;
                      if (!db.objectStoreNames.contains('thread') || !db.objectStoreNames.contains('shell')) { db.close(); done(false); return; }
                      const transaction = db.transaction(['shell', 'thread'], 'readonly');
                      let shell = false, thread = false;
                      const shells = transaction.objectStore('shell').getAll();
                      const threads = transaction.objectStore('thread').getAll();
                      shells.onsuccess = () => { shell = shells.result.some(raw => typeof raw === 'string' && raw.includes('reopen-fixture')); };
                      threads.onsuccess = () => { thread = threads.result.some(raw => typeof raw === 'string' && raw.includes(threadId) && raw.includes('Reopen fixture 0000 assistant 0199')); };
                      transaction.oncomplete = () => { db.close(); done(shell && thread); };
                      transaction.onerror = () => { db.close(); done(false); };
                    };
                "#,
                "args": [selected_thread],
            }))).map(|value| value == true)
        })?;
        let snapshot = self.reopen_snapshot(selected_thread, thread_count, message_count)?;
        self.command("POST", "/url", Some(json!({"url": "about:blank"})))?;
        Ok((route, snapshot))
    }

    pub(in crate::startup_probe) fn reopen(
        &self,
        origin: &str,
        route: &str,
        selected_thread: &str,
        thread_count: usize,
        message_count: usize,
    ) -> Result<Value> {
        let observer = include_str!("reopen-observer.js")
            .replace("REOPEN_EXPECTED_PATH", &serde_json::to_string(route)?)
            .replace("REOPEN_THREAD_ID", &serde_json::to_string(selected_thread)?);
        self.command(
            "POST",
            "/goog/cdp/execute",
            Some(json!({
                "cmd": "Page.addScriptToEvaluateOnNewDocument", "params": {"source": observer},
            })),
        )?;
        self.command(
            "POST",
            "/url",
            Some(json!({"url": format!("{origin}{route}")})),
        )?;
        self.wait_for("the restored thread and authoritative HTTP responses", || {
            self.script("const t = window.fixtureReopenTiming; return !!t && t.firstShellVisibleMillis > 0 && t.selectedTextVisibleMillis > 0 && t.composerInteractiveMillis > 0 && t.authoritativeShellHttpMillis > 0 && t.authoritativeThreadHttpMillis > 0;")
                .map(|value| value == true)
        })?;
        let timing = self.script("return window.fixtureReopenTiming;")?;
        if timing["shellHttpStatus"] != 200 || timing["threadHttpStatus"] != 200 {
            return Err("reopened client did not complete its authoritative HTTP loads".into());
        }
        let snapshot = self.reopen_snapshot(selected_thread, thread_count, message_count)?;
        Ok(json!({"timing": timing, "snapshot": snapshot}))
    }

    fn reopen_snapshot(
        &self,
        selected_thread: &str,
        thread_count: usize,
        message_count: usize,
    ) -> Result<Value> {
        let snapshot = self.command(
            "POST",
            "/execute/async",
            Some(json!({
                "script": include_str!("reopen-snapshot.js"),
                "args": [selected_thread, thread_count, message_count],
            })),
        )?;
        if snapshot["valid"] != true {
            return Err(
                format!("mature workspace snapshot disagrees with fixture: {snapshot}").into(),
            );
        }
        Ok(snapshot)
    }
}
