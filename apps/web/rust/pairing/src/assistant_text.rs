use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use dioxus::prelude::*;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;
use web_sys::Element as DomElement;

use super::{AbortController, AbortHandle, Abortable, PairingMount};

#[derive(Clone)]
struct Presentation {
    text: String,
    sequence: String,
    updated_at: String,
    streaming: bool,
}

// A deliberately small paragraph subset. Markdown, links, whitespace-sensitive
// formats and richer content continue through the existing application renderer.
fn plain_paragraph(text: &str) -> bool {
    let ordered_list = text.split_once('.').is_some_and(|(prefix, _)| {
        !prefix.is_empty() && prefix.bytes().all(|byte| byte.is_ascii_digit())
    });
    !ordered_list
        && !text.is_empty()
        && !text.starts_with(' ')
        && !text.ends_with(' ')
        && !text.contains("  ")
        && text
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | ',' | '!' | '?' | '\''))
        && text
            .split('.')
            .skip(1)
            .all(|part| part.is_empty() || part.starts_with(' '))
}

struct Model {
    current: RefCell<Presentation>,
    update: Cell<Option<Callback<Presentation>>>,
}

#[wasm_bindgen]
pub struct AssistantTextMount {
    _mount: PairingMount,
    model: Rc<Model>,
}

impl Drop for AssistantTextMount {
    fn drop(&mut self) {
        self.model.update.set(None);
    }
}

#[wasm_bindgen]
impl AssistantTextMount {
    pub fn update(&self, text: String, sequence: String, updated_at: String, streaming: bool) {
        let next = Presentation {
            text,
            sequence,
            updated_at,
            streaming,
        };
        self.model.current.replace(next.clone());
        if let Some(update) = self.model.update.get() {
            update.call(next);
        }
    }
}

#[wasm_bindgen]
pub fn mount_assistant_text(
    root: DomElement,
    text: String,
    sequence: String,
    updated_at: String,
    streaming: bool,
) -> Result<AssistantTextMount, JsValue> {
    let listeners = AbortController::new()?;
    let (renderer, registration) = AbortHandle::new_pair();
    let model = Rc::new(Model {
        current: RefCell::new(Presentation {
            text,
            sequence,
            updated_at,
            streaming,
        }),
        update: Cell::new(None),
    });
    let dom = VirtualDom::new_with_props(assistant_text, model.clone());
    let config = dioxus_web::Config::new().rootelement(root.clone());
    spawn_local(async move {
        let _ = Abortable::new(dioxus_web::run(dom, config), registration).await;
    });
    Ok(AssistantTextMount {
        _mount: PairingMount {
            root,
            listeners,
            renderer,
        },
        model,
    })
}

fn assistant_text(model: Rc<Model>) -> Element {
    let mut presentation = use_signal(|| model.current.borrow().clone());
    let update = use_callback(move |next| presentation.set(next));
    use_hook(move || model.update.set(Some(update)));
    let current = presentation.read();
    let supported = plain_paragraph(&current.text);
    rsx! {
        div {
            class: "chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word] text-sm leading-relaxed text-foreground/[calc(90%+var(--appearance-contrast-boost)/10)]",
            "data-assistant-text-renderer": "dioxus-wasm",
            "data-supported": "{supported}",
            // This is the applied thread sequence, not an invented item revision.
            "data-snapshot-sequence": "{current.sequence}",
            "data-message-updated-at": "{current.updated_at}",
            "data-streaming": "{current.streaming}",
            if supported { p { "{current.text}" } }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::plain_paragraph;

    #[test]
    fn retains_formats_outside_the_plain_paragraph_subset() {
        for text in [
            "",
            "# title",
            "1. item",
            "01.",
            "**bold**",
            "a\nb",
            " a",
            "a  b",
            "a\tb",
            "https://example.org",
            "www.example.org",
            "<b>text</b>",
            "[link](url)",
            "a_b",
            "- list",
            "&amp;",
        ] {
            assert!(!plain_paragraph(text), "{text:?}");
        }
        assert!(plain_paragraph(
            "I'll track the three steps and inspect both files."
        ));
        assert!(plain_paragraph("Hello 世界!"));
    }
}
