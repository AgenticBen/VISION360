// Test helpers: drive the real API handler in-process with fake req/res.
import { Readable } from "node:stream";
import { createApp } from "../server/lib/api.mjs";
import { openStore } from "../server/lib/store.mjs";

export async function makeApp(env = {}) {
  const store = openStore(":memory:");
  const app = await createApp({ store, env: { V360_OUTBOX_DIR: process.env.TMPDIR ? process.env.TMPDIR + "/v360-outbox" : "/tmp/v360-outbox", ...env } });
  return app;
}

export function call(app, method, url, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Readable.from(data);
    req.method = method; req.url = url; req.headers = { host: "localhost:8360", ...headers };
    req.socket = { remoteAddress: "test-" + Math.random() };
    const res = {
      status: 0, headers: {}, body: "",
      writeHead(s, h) { this.status = s; this.headers = h || {}; },
      end(b) { this.body = b ? String(b) : ""; resolve({ status: this.status, headers: this.headers, json: this.body ? JSON.parse(this.body) : null }); },
    };
    app.handle(req, res);
  });
}

export async function startSession(app, mode = "text") {
  const r = await call(app, "POST", "/api/session", { noticeAccepted: true, mode });
  return { id: r.json.sessionId, token: r.json.token, first: r.json };
}

export function talker(app, sess) {
  let n = 0;
  return async (text, extra = {}) => {
    const r = await call(app, "POST", `/api/session/${sess.id}/turn`, { text, clientTurnId: "t" + (++n) + Math.random(), ...extra }, { authorization: "Bearer " + sess.token });
    if (r.status !== 200) throw new Error("turn failed " + r.status + " " + JSON.stringify(r.json));
    return r.json;
  };
}
