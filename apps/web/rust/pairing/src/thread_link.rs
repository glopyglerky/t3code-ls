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
    href: String,
    label: String,
    class_name: String,
}

struct Model {
    current: RefCell<Presentation>,
    update: Cell<Option<Callback<Presentation>>>,
}

#[wasm_bindgen]
pub struct ThreadLinkMount {
    _mount: PairingMount,
    model: Rc<Model>,
}

impl Drop for ThreadLinkMount {
    fn drop(&mut self) {
        self.model.update.set(None);
    }
}

#[wasm_bindgen]
impl ThreadLinkMount {
    pub fn update(&self, href: String, label: String, class_name: String) {
        let next = Presentation {
            href,
            label,
            class_name,
        };
        self.model.current.replace(next.clone());
        if let Some(update) = self.model.update.get() {
            update.call(next);
        }
    }
}

// The host supplies a router-produced local href. Rust owns the semantic anchor;
// the existing browser router owns admission, history and selected-thread state.
#[wasm_bindgen]
pub fn mount_thread_link(
    root: DomElement,
    href: String,
    label: String,
    class_name: String,
) -> Result<ThreadLinkMount, JsValue> {
    let listeners = AbortController::new()?;
    let (renderer, registration) = AbortHandle::new_pair();
    let model = Rc::new(Model {
        current: RefCell::new(Presentation {
            href,
            label,
            class_name,
        }),
        update: Cell::new(None),
    });
    let dom = VirtualDom::new_with_props(thread_link, model.clone());
    let config = dioxus_web::Config::new().rootelement(root.clone());
    spawn_local(async move {
        let _ = Abortable::new(dioxus_web::run(dom, config), registration).await;
    });
    Ok(ThreadLinkMount {
        _mount: PairingMount {
            root,
            listeners,
            renderer,
        },
        model,
    })
}

fn thread_link(model: Rc<Model>) -> Element {
    let mut presentation = use_signal(|| model.current.borrow().clone());
    let update = use_callback(move |next| presentation.set(next));
    use_hook(move || model.update.set(Some(update)));
    let current = presentation.read();
    rsx! {
        a {
            href: "{current.href}",
            class: "{current.class_name}",
            "data-thread-link-renderer": "dioxus-wasm",
            "{current.label}"
        }
    }
}
