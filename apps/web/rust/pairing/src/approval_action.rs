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
    class_name: String,
    label: String,
    disabled: bool,
}

struct ApprovalModel {
    presentation: RefCell<Presentation>,
    update: Cell<Option<Callback<Presentation>>>,
}

#[wasm_bindgen]
pub struct ApprovalActionMount {
    _mount: PairingMount,
    model: Rc<ApprovalModel>,
}

impl Drop for ApprovalActionMount {
    fn drop(&mut self) {
        self.model.update.set(None);
    }
}

#[wasm_bindgen]
impl ApprovalActionMount {
    pub fn update(&self, class_name: String, label: String, disabled: bool) {
        let presentation = Presentation {
            class_name,
            label,
            disabled,
        };
        self.model.presentation.replace(presentation.clone());
        if let Some(update) = self.model.update.get() {
            update.call(presentation);
        }
    }
}

#[wasm_bindgen]
pub fn mount_approval_action(
    root: DomElement,
    class_name: String,
    label: String,
    disabled: bool,
) -> Result<ApprovalActionMount, JsValue> {
    let listeners = AbortController::new()?;
    let (renderer, registration) = AbortHandle::new_pair();
    let model = Rc::new(ApprovalModel {
        presentation: RefCell::new(Presentation {
            class_name,
            label,
            disabled,
        }),
        update: Cell::new(None),
    });
    let dom = VirtualDom::new_with_props(approval_action, model.clone());
    let config = dioxus_web::Config::new().rootelement(root.clone());
    spawn_local(async move {
        let _ = Abortable::new(dioxus_web::run(dom, config), registration).await;
    });
    Ok(ApprovalActionMount {
        _mount: PairingMount {
            root,
            listeners,
            renderer,
        },
        model,
    })
}

fn approval_action(model: Rc<ApprovalModel>) -> Element {
    let mut presentation = use_signal(|| model.presentation.borrow().clone());
    let update = use_callback(move |next| presentation.set(next));
    use_hook(move || model.update.set(Some(update)));
    let current = presentation.read();
    rsx! {
        button {
            r#type: "button",
            "data-approval-action-renderer": "dioxus-wasm",
            class: "{current.class_name}",
            aria_label: "{current.label}",
            disabled: current.disabled,
            "{current.label}"
        }
    }
}
