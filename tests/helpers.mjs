// Test helpers: drive the real API handler in-process with fake req/res.
import { Readable } from "node:stream";
import { createApp } from "../server/lib/api.mjs";
import { openStore } from "../server/lib/store.mjs";

let appCount = 0;
export async function makeApp(env = {}) {
  const store = openStore(":memory:");
  const tmp = process.env.TMPDIR || "/tmp";
  const adminDir = `${tmp}/v360-admin-test-${process.pid}-${++appCount}`;
  const app = await createApp({ store, env: { V360_OUTBOX_DIR: tmp + "/v360-outbox", V360_ADMIN_STORE_DIR: adminDir, ...env } });
  return app;
}

export function call(app, method, url, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Readable.from(data);
    req.method = method; req.url = url; req.headers = { host: "localhost:8360", ...(method === "GET" ? {} : { origin: "http://localhost:8360" }), ...headers };
    req.socket = { remoteAddress: "test-" + Math.random() };
    const res = {
      status: 0, headers: {}, body: "",
      writeHead(s, h) { this.status = s; this.headers = h || {}; },
      end(b) {
        const isJson = String((this.headers || {})["Content-Type"] || "").includes("json");
        this.body = b ? (isJson ? String(b) : b) : "";
        resolve({ status: this.status, headers: this.headers, json: isJson && this.body ? JSON.parse(this.body) : null, raw: this.body });
      },
    };
    app.handle(req, res);
  });
}

// Starts a session and, by default, answers the first-name question ("Sam")
// so tests begin at the "what's going on?" step. Pass name: null to skip that.
export async function startSession(app, mode = "text", { name = "Sam" } = {}) {
  const r = await call(app, "POST", "/api/session", { noticeAccepted: true, mode });
  const s = { id: r.json.sessionId, token: r.json.token, first: r.json };
  if (name) {
    const n = await call(app, "POST", `/api/session/${s.id}/turn`, { text: name, clientTurnId: "name-" + Math.random() }, { authorization: "Bearer " + s.token });
    s.afterName = n.json;
  }
  return s;
}

export function talker(app, sess) {
  let n = 0;
  return async (text, extra = {}) => {
    const r = await call(app, "POST", `/api/session/${sess.id}/turn`, { text, clientTurnId: "t" + (++n) + Math.random(), ...extra }, { authorization: "Bearer " + sess.token });
    if (r.status !== 200) throw new Error("turn failed " + r.status + " " + JSON.stringify(r.json));
    return r.json;
  };
}
