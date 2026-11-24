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

#[derive(Clone, Copy)]
enum Action {
    Submit,
    Stop,
}

struct SubmitModel {
    action: Action,
    presentation: RefCell<Presentation>,
    update: Cell<Option<Callback<Presentation>>>,
}

#[wasm_bindgen]
pub struct ComposerSubmitMount {
    _mount: PairingMount,
    model: Rc<SubmitModel>,
}

impl Drop for ComposerSubmitMount {
    fn drop(&mut self) {
        self.model.update.set(None);
    }
}

#[wasm_bindgen]
impl ComposerSubmitMount {
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
pub fn mount_composer_submit(
    root: DomElement,
    class_name: String,
    label: String,
    disabled: bool,
) -> Result<ComposerSubmitMount, JsValue> {
    mount_composer_button(root, class_name, label, disabled, Action::Submit)
}

#[wasm_bindgen]
pub fn mount_composer_stop(
    root: DomElement,
    class_name: String,
    label: String,
    disabled: bool,
) -> Result<ComposerSubmitMount, JsValue> {
    mount_composer_button(root, class_name, label, disabled, Action::Stop)
}

fn mount_composer_button(
    root: DomElement,
    class_name: String,
    label: String,
    disabled: bool,
    action: Action,
) -> Result<ComposerSubmitMount, JsValue> {
    let listeners = AbortController::new()?;
    let (renderer, registration) = AbortHandle::new_pair();
    let model = Rc::new(SubmitModel {
        action,
        presentation: RefCell::new(Presentation {
            class_name,
            label,
            disabled,
        }),
        update: Cell::new(None),
    });
    let dom = VirtualDom::new_with_props(composer_submit, model.clone());
    let config = dioxus_web::Config::new().rootelement(root.clone());
    spawn_local(async move {
        let _ = Abortable::new(dioxus_web::run(dom, config), registration).await;
    });
    Ok(ComposerSubmitMount {
        _mount: PairingMount {
            root,
            listeners,
            renderer,
        },
        model,
    })
}

fn composer_submit(model: Rc<SubmitModel>) -> Element {
    let action = model.action;
    let mut presentation = use_signal(|| model.presentation.borrow().clone());
    let update = use_callback(move |next| presentation.set(next));
    use_hook(move || model.update.set(Some(update)));
    let current = presentation.read();
    let (button_type, submit_renderer, stop_renderer) = match action {
        Action::Submit => ("submit", Some("dioxus-wasm"), None),
        Action::Stop => ("button", None, Some("dioxus-wasm")),
    };
    rsx! {
        button {
            r#type: button_type,
            "data-composer-submit-renderer": submit_renderer,
            "data-composer-stop-renderer": stop_renderer,
            class: "{current.class_name}",
            aria_label: "{current.label}",
            disabled: current.disabled,
        }
    }
}
