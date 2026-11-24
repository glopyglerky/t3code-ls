use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use dioxus::prelude::*;
use js_sys::Function;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;
use web_sys::{Element as DomElement, HtmlInputElement, KeyboardEvent};

use super::{AbortController, AbortHandle, Abortable, PairingMount, ScopedListener};

#[derive(Clone)]
struct FindState {
    query: String,
    count: String,
    status: String,
    busy: bool,
    no_results: bool,
    navigation_disabled: bool,
    focus_request: u32,
}

struct FindModel {
    state: RefCell<FindState>,
    update: Cell<Option<Callback<FindState>>>,
}

#[wasm_bindgen]
pub struct ThreadFindMount {
    _mount: PairingMount,
    _listeners: [ScopedListener; 3],
    model: Rc<FindModel>,
}

impl Drop for ThreadFindMount {
    fn drop(&mut self) {
        self.model.update.set(None);
    }
}

#[wasm_bindgen]
impl ThreadFindMount {
    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &self,
        query: String,
        count: String,
        status: String,
        busy: bool,
        no_results: bool,
        navigation_disabled: bool,
        focus_request: u32,
    ) {
        let state = FindState {
            query,
            count,
            status,
            busy,
            no_results,
            navigation_disabled,
            focus_request,
        };
        self.model.state.replace(state.clone());
        if let Some(update) = self.model.update.get() {
            update.call(state);
        }
    }
}

#[wasm_bindgen]
pub fn mount_thread_find(
    root: DomElement,
    on_action: Function,
) -> Result<ThreadFindMount, JsValue> {
    let lifetime = AbortController::new()?;
    let signal = lifetime.signal();
    let on_query = on_action.clone();
    let input = ScopedListener::new(&root, &signal, "input", move |event| {
        if let Some(input) = event
            .target()
            .and_then(|target| target.dyn_into::<HtmlInputElement>().ok())
        {
            let _ = on_query.call2(&JsValue::UNDEFINED, &"query".into(), &input.value().into());
        }
    })?;
    let on_navigate = on_action.clone();
    let keydown = ScopedListener::new(&root, &signal, "keydown", move |event| {
        if let Some(key) = event.dyn_ref::<KeyboardEvent>()
            && key.key() == "Enter"
            && !key.is_composing()
            && key.key_code() != 229
            && event
                .target()
                .is_some_and(|target| target.is_instance_of::<HtmlInputElement>())
        {
            event.prevent_default();
            event.stop_propagation();
            let action = if key.shift_key() { "previous" } else { "next" };
            let _ = on_navigate.call1(&JsValue::UNDEFINED, &action.into());
        }
    })?;
    let click = ScopedListener::new(&root, &signal, "click", move |event| {
        if let Some(action) = event
            .target()
            .and_then(|target| target.dyn_into::<DomElement>().ok())
            .and_then(|target| target.closest("button[data-find-action]").ok().flatten())
            .and_then(|button| button.get_attribute("data-find-action"))
        {
            let _ = on_action.call1(&JsValue::UNDEFINED, &action.into());
        }
    })?;
    let (renderer, registration) = AbortHandle::new_pair();
    let model = Rc::new(FindModel {
        state: RefCell::new(FindState {
            query: String::new(),
            count: String::new(),
            status: String::new(),
            busy: false,
            no_results: false,
            navigation_disabled: true,
            focus_request: 0,
        }),
        update: Cell::new(None),
    });
    let dom = VirtualDom::new_with_props(
        thread_find,
        FindProps {
            root: root.clone(),
            model: model.clone(),
        },
    );
    let config = dioxus_web::Config::new().rootelement(root.clone());
    spawn_local(async move {
        let _ = Abortable::new(dioxus_web::run(dom, config), registration).await;
    });
    Ok(ThreadFindMount {
        _mount: PairingMount {
            root,
            listeners: lifetime,
            renderer,
        },
        _listeners: [input, keydown, click],
        model,
    })
}

#[derive(Clone)]
struct FindProps {
    root: DomElement,
    model: Rc<FindModel>,
}

fn thread_find(props: FindProps) -> Element {
    let model = props.model.clone();
    let mut state = use_signal(|| model.state.borrow().clone());
    let update = use_callback(move |next| state.set(next));
    use_hook(move || model.update.set(Some(update)));

    let root = props.root;
    let last_focus = use_hook(|| Rc::new(Cell::new(None)));
    use_effect(move || {
        let request = state.read().focus_request;
        if last_focus.get() == Some(request) {
            return;
        }
        if let Some(input) = root
            .query_selector("input[type=search]")
            .ok()
            .flatten()
            .and_then(|element| element.dyn_into::<HtmlInputElement>().ok())
        {
            let _ = input.focus();
            input.select();
            last_focus.set(Some(request));
        }
    });

    let current = state.read();
    let count_tone = if current.no_results {
        "text-destructive"
    } else {
        "text-muted-foreground"
    };
    let disabled = current.navigation_disabled;
    rsx! {
        div {
            "data-thread-find-renderer": "dioxus-wasm",
            role: "search",
            aria_label: "Find in thread",
            aria_busy: "{current.busy}",
            class: "flex h-9 w-full items-center gap-1 rounded-2xl dropdown-glass px-2",
            input {
                r#type: "search",
                aria_label: "Find in thread",
                placeholder: "Find in thread",
                maxlength: 200,
                spellcheck: "false",
                autocomplete: "off",
                class: "min-w-0 flex-1 rounded px-1 text-sm leading-7 outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-search-cancel-button]:appearance-none",
                value: "{current.query}",
            }
            span { aria_live: "polite", class: "min-w-10 text-center text-xs tabular-nums {count_tone}", "{current.count}" }
            if current.status == "error" {
                button { r#type: "button", "data-find-action": "retry", class: "rounded px-1 text-xs hover:bg-muted", "Retry" }
            }
            button {
                r#type: "button", "data-find-action": "previous", aria_label: "Previous match",
                disabled: disabled, class: "h-6 w-6 rounded hover:bg-muted disabled:opacity-50",
                span { aria_hidden: "true", "↑" }
            }
            button {
                r#type: "button", "data-find-action": "next", aria_label: "Next match",
                disabled: disabled, class: "h-6 w-6 rounded hover:bg-muted disabled:opacity-50",
                span { aria_hidden: "true", "↓" }
            }
            button {
                r#type: "button", "data-find-action": "close", aria_label: "Close find",
                class: "h-6 w-6 rounded hover:bg-muted",
                span { aria_hidden: "true", "×" }
            }
        }
    }
}
