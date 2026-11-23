export interface DioxusMount {
  free(): void;
}

export interface WelcomeMount extends DioxusMount {
  update(agentReady: boolean, isImporting: boolean, selectedCount: number, newCount: number): void;
}

export type ThreadFindAction = "query" | "next" | "previous" | "retry" | "close";

export interface ThreadFindMount extends DioxusMount {
  update(
    query: string, count: string, status: string, busy: boolean, noResults: boolean,
    navigationDisabled: boolean, focusRequestId: number,
  ): void;
}

interface OnboardingBindings {
  default(): Promise<unknown>;
  mount_pairing_form(
    root: HTMLDivElement,
    token: string,
    initialError: string,
    submitCredential: (credential: string) => Promise<string | null>,
    onAuthenticated: () => void,
  ): DioxusMount;
  mount_welcome_controls(
    root: HTMLDivElement,
    agentReady: boolean,
    isImporting: boolean,
    selectedCount: number,
    newCount: number,
    onStart: () => void,
  ): WelcomeMount;
  mount_thread_find(
    root: HTMLDivElement,
    action: (action: ThreadFindAction, query?: string) => void,
  ): ThreadFindMount;
}

async function initialize(): Promise<OnboardingBindings> {
  const url = new URL(`${import.meta.env.BASE_URL}pairing-wasm/local_pairing.js`, window.location.origin);
  const bindings: OnboardingBindings = await import(/* @vite-ignore */ url.href);
  await bindings.default();
  return bindings;
}

let bindings: Promise<OnboardingBindings> | undefined;

export const loadOnboardingBindings = () => (bindings ??= initialize());
