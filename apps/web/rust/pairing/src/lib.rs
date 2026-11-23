#![cfg(target_arch = "wasm32")]

use std::{cell::Cell, rc::Rc};

use dioxus::prelude::*;
use futures_util::future::{AbortHandle, Abortable};
use js_sys::{Function, Promise};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{JsFuture, spawn_local};
use web_sys::{
    AbortController, AbortSignal, AddEventListenerOptions, Element as DomElement,
    Event as DomEvent, HtmlInputElement,
};

const FORM_ID: &str = "local-pairing-form";
const RELOAD_ID: &str = "local-pairing-reload";
const FAILED: &str = "Authentication failed.";

#[wasm_bindgen]
pub struct PairingMount {
    root: DomElement,
    listeners: AbortController,
    renderer: AbortHandle,
}

impl Drop for PairingMount {
    fn drop(&mut self) {
        self.listeners.abort();
        self.renderer.abort();
        if let Some(input) = token_input(&self.root) {
            input.set_value("");
        }
        self.root.set_text_content(None);
        let _ = self.root.remove_attribute("data-dioxus-id");
    }
}

#[wasm_bindgen]
pub fn mount_pairing_form(
    root: DomElement,
    token: String,
    initial_error: String,
    submit_credential: Function,
    on_authenticated: Function,
) -> Result<PairingMount, JsValue> {
    let listeners = AbortController::new()?;
    let (renderer, registration) = AbortHandle::new_pair();
    let dom = VirtualDom::new_with_props(
        pairing_form,
        PairingProps {
            root: root.clone(),
            lifetime: listeners.signal(),
            first_token: Rc::new(Cell::new(Some(token))),
            initial_error,
            submit_credential,
            on_authenticated,
        },
    );
    let config = dioxus_web::Config::new().rootelement(root.clone());
    spawn_local(async move {
        let _ = Abortable::new(dioxus_web::run(dom, config), registration).await;
    });
    Ok(PairingMount {
        root,
        listeners,
        renderer,
    })
}

#[derive(Clone)]
struct PairingProps {
    root: DomElement,
    lifetime: AbortSignal,
    first_token: Rc<Cell<Option<String>>>,
    initial_error: String,
    submit_credential: Function,
    on_authenticated: Function,
}

enum Submission {
    Ready,
    Pending,
    Rejected(String),
}

fn pairing_form(props: PairingProps) -> Element {
    let mut submission = use_signal(|| {
        if props.initial_error.is_empty() {
            Submission::Ready
        } else {
            Submission::Rejected(props.initial_error.clone())
        }
    });
    let lifetime = props.lifetime.clone();
    let submit = use_callback(move |credential: String| {
        if lifetime.aborted() || matches!(*submission.peek(), Submission::Pending) {
            return;
        }
        submission.set(Submission::Pending);
        let request = props.submit_credential.clone();
        let authenticated = props.on_authenticated.clone();
        let lifetime = lifetime.clone();
        spawn(async move {
            let error = exchange_credential(request, credential).await;
            if lifetime.aborted() {
                return;
            }
            if let Some(error) = error {
                submission.set(Submission::Rejected(error));
            } else {
                let _ = authenticated.call0(&JsValue::UNDEFINED);
            }
        });
    });

    // The web renderer does not expose listener teardown. Keep these handlers owned by this mount.
    let root = props.root.clone();
    let listeners = use_hook(move || {
        bind_events(&root, &props.lifetime, submit)
            .map(Rc::new)
            .ok()
    });
    let form_available = listeners.is_some();
    let root = props.root.clone();
    let first_token = props.first_token;
    use_effect(move || {
        if form_available && let Some(token) = first_token.take().filter(|token| !token.is_empty())
        {
            if let Some(input) = token_input(&root) {
                input.set_value(&token);
            }
            submit.call(token);
        }
    });
    let root = props.root;
    use_effect(move || {
        if matches!(*submission.read(), Submission::Rejected(_)) {
            if let Some(input) = token_input(&root) {
                let _ = input.focus();
            }
        }
    });

    let current = submission.read();
    let pending = matches!(*current, Submission::Pending);
    let error = match &*current {
        Submission::Rejected(message) => Some(message.as_str()),
        _ => None,
    };
    let continue_label = if pending { "Pairing..." } else { "Continue" };
    if !form_available {
        return rsx! { div { class: "mt-6 text-destructive", role: "alert", "Could not open the pairing form. Reload the app to try again." } };
    }

    rsx! {
        form {
            id: FORM_ID,
            "data-pairing-renderer": "dioxus-wasm",
            class: "mt-6 space-y-4",
            aria_busy: "{pending}",
            div { class: "space-y-2",
                label { class: "text-sm font-medium", r#for: "pairing-token", "Pairing token" }
                input {
                    id: "pairing-token",
                    class: "h-8.5 w-full rounded-lg border border-input bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-64",
                    r#type: "text",
                    "autocapitalize": "none",
                    autocomplete: "off",
                    autocorrect: "off",
                    spellcheck: "false",
                    placeholder: "Paste a one-time token or pairing secret",
                    disabled: pending,
                    aria_invalid: error.map(|_| "true"),
                    aria_describedby: error.map(|_| "pairing-error"),
                }
            }
            if let Some(message) = error {
                div { id: "pairing-error", class: "text-sm text-destructive", role: "alert", "{message}" }
            }
            div { class: "flex flex-wrap gap-2",
                button {
                    class: "h-8 rounded-md border border-primary bg-primary px-2.5 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-64",
                    r#type: "submit",
                    disabled: pending,
                    "{continue_label}"
                }
                button {
                    id: RELOAD_ID,
                    class: "h-8 rounded-md border border-input bg-popover px-2.5 text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-64",
                    r#type: "button",
                    disabled: pending,
                    "Reload app"
                }
            }
        }
    }
}

fn token_input(root: &DomElement) -> Option<HtmlInputElement> {
    root.query_selector("#pairing-token").ok()??.dyn_into().ok()
}

struct ScopedListener {
    root: DomElement,
    name: &'static str,
    callback: Closure<dyn Fn(&DomEvent)>,
}

impl ScopedListener {
    fn new(
        root: &DomElement,
        lifetime: &AbortSignal,
        name: &'static str,
        handler: impl Fn(&DomEvent) + 'static,
    ) -> Result<Self, JsValue> {
        let callback = Closure::<dyn Fn(&DomEvent)>::own_aborting(handler);
        let options = AddEventListenerOptions::new();
        options.set_signal(lifetime);
        root.add_event_listener_with_callback_and_add_event_listener_options(
            name,
            callback.as_ref().unchecked_ref(),
            &options,
        )?;
        Ok(Self {
            root: root.clone(),
            name,
            callback,
        })
    }
}

impl Drop for ScopedListener {
    fn drop(&mut self) {
        let _ = self
            .root
            .remove_event_listener_with_callback(self.name, self.callback.as_ref().unchecked_ref());
    }
}

fn bind_events(
    root: &DomElement,
    lifetime: &AbortSignal,
    submit: Callback<String>,
) -> Result<[ScopedListener; 2], JsValue> {
    let on_submit = ScopedListener::new(root, lifetime, "submit", move |event| {
        if let Some(form) = event
            .target()
            .and_then(|target| target.dyn_into::<DomElement>().ok())
            && form.id() == FORM_ID
        {
            event.prevent_default();
            if let Some(input) = token_input(&form) {
                submit.call(input.value());
            }
        }
    })?;
    let on_reload = ScopedListener::new(root, lifetime, "click", |event| {
        if event
            .target()
            .and_then(|target| target.dyn_into::<DomElement>().ok())
            .is_some_and(|button| button.id() == RELOAD_ID)
            && let Some(window) = web_sys::window()
        {
            let _ = window.location().reload();
        }
    })?;
    Ok([on_submit, on_reload])
}

async fn exchange_credential(request: Function, credential: String) -> Option<String> {
    let promise = request
        .call1(&JsValue::UNDEFINED, &JsValue::from_str(&credential))
        .and_then(JsCast::dyn_into::<Promise>);
    let Ok(promise) = promise else {
        return Some(FAILED.to_owned());
    };
    match JsFuture::from(promise).await {
        Ok(value) if value.is_null() => None,
        Ok(value) => Some(value.as_string().unwrap_or_else(|| FAILED.to_owned())),
        Err(_) => Some(FAILED.to_owned()),
    }
}
