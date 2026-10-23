import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Login } from "./Login.js";
import { useStore, type AppState } from "../store.js";

/**
 * The login gate, driven through the real screen and the real store over a
 * stubbed HTTP boundary.
 *
 * Three claims matter here. A correct token goes to `POST /api/login` as JSON
 * `{ token }` and flips the store's session flags, so the shell takes over. A
 * wrong token surfaces the server's own message in the form instead of throwing
 * out of the render. And the token never reaches local or session storage,
 * where it would outlive the cookie.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INITIAL: Partial<AppState> = {
  authenticated: false,
  isAdmin: false,
  session: null,
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Stub {
  loginStatus: number;
  loginBody: unknown;
  calls: Array<{ url: string; method: string; body: string }>;
}

let stub: Stub;

function stubServer(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    stub.calls.push({ url, method, body });
    if (url === "/api/login" && method === "POST") {
      stub.loginBody = JSON.parse(body) as unknown;
      if (stub.loginStatus !== 200) {
        return json(
          { error: "unauthorized", message: "That token was not accepted." },
          stub.loginStatus,
        );
      }
      return json({ ok: true, isAdmin: true });
    }
    return json({});
  }) as unknown as typeof fetch;
}

interface Mounted {
  host: HTMLElement;
  render: (fn: () => void) => Promise<void>;
}

const mounted: Array<{ root: Root; host: HTMLElement; done: boolean }> = [];

async function mountLogin(): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const entry = { root, host, done: false };
  mounted.push(entry);
  const render = async (fn: () => void) => {
    await act(async () => {
      fn();
    });
  };
  await render(() => root.render(<Login />));
  return { host, render };
}

function field(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>("#login-token");
  if (input === null) throw new Error("no login field");
  return input;
}

/** Set a controlled input through React's own value setter, then raise `input`. */
async function typeInto(
  render: Mounted["render"],
  host: HTMLElement,
  value: string,
): Promise<void> {
  const input = field(host);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) throw new Error("no input value setter");
  await render(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(render: Mounted["render"], host: HTMLElement): Promise<void> {
  const form = host.querySelector<HTMLFormElement>("form.login-form");
  if (form === null) throw new Error("no login form");
  await render(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;

beforeEach(() => {
  useStore.setState(INITIAL);
  stub = { loginStatus: 200, loginBody: null, calls: [] };
  stubServer();
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    if (entry.done) continue;
    entry.done = true;
    act(() => entry.root.unmount());
    entry.host.remove();
  }
  globalThis.fetch = originalFetch;
  // jsdom's `localStorage` is a getter on the window proxy, so assignment
  // throws; define the original descriptor back instead.
  if (originalLocalStorage === undefined) {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  } else {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  }
  vi.restoreAllMocks();
});

it("posts the admin token as JSON and flips the session flags", async () => {
  const { host, render } = await mountLogin();
  await typeInto(render, host, "  brain_admin_test  ");
  await submit(render, host);

  expect(stub.loginBody).toEqual({ token: "brain_admin_test" });
  expect(stub.calls[0]?.url).toBe("/api/login");
  expect(stub.calls[0]?.method).toBe("POST");
  const state = useStore.getState();
  expect(state.authenticated).toBe(true);
  expect(state.isAdmin).toBe(true);
  expect(state.session).toEqual({ authenticated: true, isAdmin: true });
  // The field is cleared on success, before the shell replaces the screen.
  expect(field(host).value).toBe("");
});

it("shows the server's message on a rejected token and stays on the gate", async () => {
  stub.loginStatus = 401;
  const { host, render } = await mountLogin();
  await typeInto(render, host, "wrong");
  await submit(render, host);

  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe("That token was not accepted.");
  expect(useStore.getState().authenticated).toBe(false);
  expect(useStore.getState().isAdmin).toBe(false);
  // The value stays so the user can correct a typo instead of retyping it.
  expect(field(host).value).toBe("wrong");
});

it("asks for a token instead of calling the server when the field is empty", async () => {
  const { host, render } = await mountLogin();
  await typeInto(render, host, "   ");
  await submit(render, host);

  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Enter the admin token.",
  );
  expect(stub.calls).toHaveLength(0);
});

it("never writes the token to local or session storage", async () => {
  const localSet = vi.fn();
  const sessionSet = vi.fn();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { setItem: localSet, getItem: () => null, removeItem: () => {} },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { setItem: sessionSet, getItem: () => null, removeItem: () => {} },
  });

  const { host, render } = await mountLogin();
  await typeInto(render, host, "brain_admin_test");
  await submit(render, host);

  expect(localSet).not.toHaveBeenCalled();
  expect(sessionSet).not.toHaveBeenCalled();
});
