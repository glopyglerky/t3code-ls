use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use dioxus::prelude::*;
use js_sys::{Function, JsString};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;
use web_sys::{Element as DomElement, HtmlInputElement};

use super::{AbortController, AbortHandle, Abortable, PairingMount, ScopedListener};

const FORM_ID: &str = "guest-name-form";
const INPUT_ID: &str = "guest-name";
const MAX_LENGTH: u32 = 40;

#[derive(Clone)]
struct Status {
    pending: bool,
    error: String,
}
struct Model {
    status: RefCell<Status>,
    update: Cell<Option<Callback<Status>>>,
}

#[wasm_bindgen]
pub struct GuestNameMount {
    _mount: PairingMount,
    model: Rc<Model>,
}
impl Drop for GuestNameMount {
    fn drop(&mut self) {
        self.model.update.set(None);
    }
}
#[wasm_bindgen]
impl GuestNameMount {
    pub fn update(&self, pending: bool, error: String) {
        let next = Status { pending, error };
        self.model.status.replace(next.clone());
        if let Some(update) = self.model.update.get() {
            update.call(next);
        }
    }
}

#[wasm_bindgen]
pub fn mount_guest_name(
    root: DomElement,
    name: String,
    pending: bool,
    error: String,
    submit: Function,
) -> Result<GuestNameMount, JsValue> {
    let lifetime = AbortController::new()?;
    let model = Rc::new(Model {
        status: RefCell::new(Status { pending, error }),
        update: Cell::new(None),
    });
    let dom = VirtualDom::new_with_props(
        guest_name,
        Props {
            root: root.clone(),
            name,
            model: model.clone(),
            lifetime: lifetime.signal(),
            submit,
        },
    );
    let (renderer, registration) = AbortHandle::new_pair();
    let config = dioxus_web::Config::new().rootelement(root.clone());
    spawn_local(async move {
        let _ = Abortable::new(dioxus_web::run(dom, config), registration).await;
    });
    Ok(GuestNameMount {
        _mount: PairingMount {
            root,
            listeners: lifetime,
            renderer,
        },
        model,
    })
}

#[derive(Clone)]
struct Props {
    root: DomElement,
    name: String,
    model: Rc<Model>,
    lifetime: web_sys::AbortSignal,
    submit: Function,
}
fn input(root: &DomElement) -> Option<HtmlInputElement> {
    root.query_selector("#guest-name").ok()??.dyn_into().ok()
}
fn blank(name: &str) -> bool {
    JsString::from(name).trim().length() == 0
}

fn guest_name(props: Props) -> Element {
    let mut name = use_signal(|| props.name.clone());
    let mut status = use_signal(|| props.model.status.borrow().clone());
    let submitting = use_hook(|| Rc::new(Cell::new(false)));
    let gate = submitting.clone();
    let update = use_callback(move |next: Status| {
        gate.set(next.pending);
        status.set(next);
    });
    use_hook(move || props.model.update.set(Some(update)));
    let change_name = use_callback(move |value: String| name.set(value));
    let lifetime = props.lifetime.clone();
    let callback = props.submit;
    let submit = use_callback(move |value: String| {
        if lifetime.aborted() || blank(&value) || status.peek().pending || submitting.replace(true)
        {
            return;
        }
        let mut pending = (*status.peek()).clone();
        pending.pending = true;
        status.set(pending);
        if callback.call1(&JsValue::UNDEFINED, &value.into()).is_err() {
            submitting.set(false);
            status.set(Status {
                pending: false,
                error: "Could not submit your name. Try again.".into(),
            });
        }
    });
    let root = props.root.clone();
    let lifetime = props.lifetime.clone();
    let listeners = use_hook(move || {
        let on_input = ScopedListener::new(&root, &lifetime, "input", {
            let root = root.clone();
            move |_| {
                if let Some(input) = input(&root) {
                    change_name.call(input.value());
                }
            }
        });
        let on_submit = ScopedListener::new(&root, &lifetime, "submit", {
            let root = root.clone();
            move |event| {
                if !event
                    .target()
                    .and_then(|target| target.dyn_into::<DomElement>().ok())
                    .is_some_and(|form| form.id() == FORM_ID)
                {
                    return;
                }
                event.prevent_default();
                if let Some(value) = input(&root).map(|input| input.value()) {
                    submit.call(value);
                }
            }
        });
        match (on_input, on_submit) {
            (Ok(input), Ok(submit)) => Some(Rc::new([input, submit])),
            _ => None,
        }
    });
    let available = listeners.is_some();
    let root = props.root;
    use_effect(move || {
        if available && let Some(input) = input(&root) {
            let _ = input.focus();
        }
    });
    if !available {
        return rsx! { p { role: "alert", "Could not open the guest name form." } };
    }
    let current = status.read();
    let error = (!current.error.is_empty()).then_some(current.error.as_str());
    let disabled = current.pending || blank(&name.read());
    rsx! {
        form { id: FORM_ID, "data-guest-name-renderer": "dioxus-wasm", aria_busy: "{current.pending}", class: "m-auto flex w-full max-w-xs flex-col gap-3 p-6",
            h1 { class: "text-base font-medium", "Join a shared thread" }
            label { class: "flex flex-col gap-1.5 text-sm", r#for: INPUT_ID, "Your name"
                input { id: INPUT_ID, r#type: "text", autocomplete: "name", maxlength: MAX_LENGTH,
                    value: "{name}", aria_invalid: error.map(|_| "true"), aria_describedby: error.map(|_| "guest-name-error"),
                    class: "h-8.5 w-full rounded-lg border border-input bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-ring" }
            }
            if let Some(message) = error { p { id: "guest-name-error", role: "alert", class: "text-sm text-destructive", "{message}" } }
            button { r#type: "submit", disabled: disabled, class: "h-8 rounded-md border border-primary bg-primary px-2.5 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-64", "Join" }
            p { class: "text-xs text-muted-foreground", "The owner sees your name and approves each message before the agent gets it." }
        }
    }
}
