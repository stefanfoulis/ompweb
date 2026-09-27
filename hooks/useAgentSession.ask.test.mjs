import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";

// Focused coverage for the rich `ask` extension UI method: an incoming `ask`
// frame must reach the same extensionDialog state as `select`/`confirm`/etc,
// and respondToExtensionUi must forward `results`/`chat` bodies unchanged.
// Harness (fake EventSource + fetch router) mirrors useAgentSession.rpc.test.mjs.

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(url) {
    this.url = String(url);
    this.readyState = FakeEventSource.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.closedByCaller = false;
    world.esInstances.push(this);
  }
  open() {
    if (this.closedByCaller) return;
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({});
    const sid = this.url.match(/\/api\/agent\/([^/]+)/)?.[1];
    this.onmessage?.({ data: JSON.stringify({ type: "connected", web: world.streams.get(sid) ?? { streamId: `stream-${sid}`, sequence: 0 } }) });
  }
  emit(event) {
    if (this.closedByCaller) return;
    const sid = this.url.match(/\/api\/agent\/([^/]+)/)?.[1];
    const previous = world.streams.get(sid) ?? { streamId: `stream-${sid}`, sequence: 0 };
    const web = event.web ?? { ...previous, sequence: previous.sequence + 1 };
    world.streams.set(sid, web);
    if (event.type === "agent_start") this.running = true;
    this.onmessage?.({ data: JSON.stringify({ ...event, web }) });
    if (event.type === "agent_end" && event.isTerminal !== false) this.running = false;
  }
  close() {
    this.closedByCaller = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function jsonResponse(status, value) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

const world = {
  esInstances: [],
  calls: [],
  sessions: new Map(),
  agents: new Map(),
  streams: new Map(),
};

async function fetchStub(url, init = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const u = String(url);
  world.calls.push({ method, url: u, body: typeof init.body === "string" ? safeParse(init.body) : null });

  let m;
  if (/\/api\/sessions\/[^/?#]+\/subagents/.test(u)) {
    return jsonResponse(200, { subagents: [] });
  }
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)\/context/)) && method === "GET") {
    const sid = decodeURIComponent(m[1]);
    const f = world.sessions.get(sid);
    if (!f) return jsonResponse(404, {});
    const context = { todoPhases: [], thinkingLevel: "off", model: null, ...f };
    return jsonResponse(200, { context });
  }
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)/)) && method === "GET") {
    const f = world.sessions.get(decodeURIComponent(m[1]));
    if (!f) return jsonResponse(404, {});
    return jsonResponse(200, {
      sessionId: decodeURIComponent(m[1]), filePath: "/fixture/session.jsonl", tree: f.tree ?? [],
      leafId: f.leafId,
      context: { todoPhases: [], thinkingLevel: "off", model: null, ...f },
    });
  }
  if (/^\/api\/models/.test(u)) {
    return jsonResponse(200, { models: {}, modelList: [], defaultModel: null });
  }
  if ((m = u.match(/\/api\/agent\/([^/?#]+)/))) {
    const sid = decodeURIComponent(m[1]);
    if (method === "GET") {
      const a = world.agents.get(sid) ?? { running: false, state: {} };
      return jsonResponse(200, { running: a.running, state: a.state });
    }
    if (method === "POST") {
      const body = typeof init.body === "string" ? safeParse(init.body) : null;
      if (body?.type === "get_subagents") return jsonResponse(200, { success: true, data: { subagents: [] } });
      return jsonResponse(200, { success: true, data: {} });
    }
  }
  return jsonResponse(404, {});
}

let visibilityState = "hidden";
const overrides = [
  [globalThis, "EventSource", { value: FakeEventSource }],
  [globalThis, "fetch", { value: fetchStub }],
  [document, "hidden", { get: () => visibilityState === "hidden" }],
  [document, "visibilityState", { get: () => visibilityState }],
  [window, "matchMedia", {
    value: (media) => Object.assign(new window.EventTarget(), { matches: false, media }),
  }],
].map(([target, key, replacement]) => ({
  target, key, replacement, original: Object.getOwnPropertyDescriptor(target, key),
}));

beforeEach(() => {
  visibilityState = "hidden";
  localStorage.clear();
  sessionStorage.clear();
  for (const { target, key, replacement } of overrides) {
    Object.defineProperty(target, key, { configurable: true, ...replacement });
  }
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    for (const { target, key, original } of overrides) {
      if (original) Object.defineProperty(target, key, original);
      else delete target[key];
    }
    localStorage.clear();
    sessionStorage.clear();
  }
});

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: {
    "@/components/ui/toast": fileURLToPath(new URL("./__fixtures__/toast-stub.mjs", import.meta.url)),
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const { useAgentSession } = await jiti.import("../hooks/useAgentSession.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(ms = 120) {
  await act(async () => {
    await sleep(ms);
  });
}

function sessionInfo(sid) {
  return {
    id: sid,
    path: "",
    cwd: "/workspace",
    name: `session ${sid}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "loaded question",
  };
}

async function mountSession(sid) {
  const session = sessionInfo(sid);
  const { result, unmount } = renderHook(() => useAgentSession({ session, newSessionCwd: null }));
  await settle();
  return {
    unmount,
    get latest() {
      return result.current;
    },
  };
}

function primeSession(sid, messages) {
  world.sessions.set(sid, { leafId: String(messages.length), messages, entryIds: messages.map((_, i) => `e${i}`) });
  world.agents.set(sid, { running: false, state: {} });
}

const userMsg = (id, text) => ({ role: "user", id, content: text, timestamp: 1 });

function lastEs() {
  return world.esInstances[world.esInstances.length - 1];
}

function resetWorld() {
  world.esInstances.length = 0;
  world.calls.length = 0;
  world.sessions.clear();
  world.agents.clear();
  world.streams.clear();
}

/** Mount + hydrate, then send a prompt and open the stream. Returns the ES. */
async function startRun(sid, message) {
  const w = await mountSession(sid);
  assert.equal(w.latest.loading, false, "hydration must complete");

  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend(message);
    await sleep(30);
  });
  const es = lastEs();
  assert.ok(es, "an EventSource must have been created");
  await act(async () => {
    es.open();
    await sendPromise;
  });
  return { w, es };
}

const askQuestions = [
  { id: "q1", question: "Which color?", options: [{ label: "Blue" }, { label: "Red" }], multi: false },
];

test("an incoming ask frame reaches extensionDialog exactly like select/confirm/input/editor", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "hello");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "extension_ui_request", id: "ask-1", method: "ask", questions: askQuestions, timeout: 30000 });
    await Promise.resolve();
  });
  assert.equal(w.latest.extensionDialog?.id, "ask-1");
  assert.equal(w.latest.extensionDialog?.method, "ask");
  assert.deepEqual(w.latest.extensionDialog?.questions, askQuestions);
});

test("responding with results sends an extension_ui_response results frame", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "hello");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "extension_ui_request", id: "ask-1", method: "ask", questions: askQuestions });
    await Promise.resolve();
  });
  const request = w.latest.extensionDialog;
  assert.ok(request, "ask dialog must be present before responding");

  const results = [{ id: "q1", selectedOptions: ["Blue"], note: "prefers cool tones" }];
  await act(async () => {
    await w.latest.respondToExtensionUi(request, { results });
  });

  const sent = world.calls.filter((c) => c.method === "POST" && c.body?.type === "extension_ui_response");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { type: "extension_ui_response", id: "ask-1", results });
});

test("responding with chat:true sends an extension_ui_response chat frame", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "hello");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "extension_ui_request", id: "ask-2", method: "ask", questions: askQuestions });
    await Promise.resolve();
  });
  const request = w.latest.extensionDialog;
  assert.ok(request);

  await act(async () => {
    await w.latest.respondToExtensionUi(request, { chat: true });
  });

  const sent = world.calls.filter((c) => c.method === "POST" && c.body?.type === "extension_ui_response");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { type: "extension_ui_response", id: "ask-2", chat: true });
});
