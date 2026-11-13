import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, mock, test } from "node:test";
import worker from "./index.ts";

const HOOK = "https://zagrajmy.net/hooks/staff-mail";
const RAW = "https://inbound.resend.test/raw/e1.eml";
const OWNERS = ["hasparus@gmail.com", "radoslaw@ganczarek.in"];
const SVIX_SECRET = Buffer.from("svix test key").toString("base64");
const raw = [
  "From: Ola <ola@example.com>",
  "To: staff@zagrajmy.net",
  "Message-ID: <abc@mail.example>",
  "Content-Type: multipart/mixed; boundary=b",
  "",
  "--b",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Ktoś prosi mojego brata o telefon.",
  "--b",
  'Content-Type: application/pdf; name="umowa.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQKJcfsj6IK".repeat(1000),
  "--b--",
  "",
].join("\r\n");

type Call = { url: string; headers: Headers; body: Uint8Array };
type Reply = Response | Error;

let kv: Map<string, string>;
let calls: Call[];
let email: Record<string, unknown>;
let hookReplies: Reply[];
let sendReplies: Reply[];

const env = () =>
  ({
    DOMAIN: "zagrajmy.net",
    ROUTES: { piotr: [OWNERS[0]], radek: [OWNERS[1]], "*": OWNERS },
    STAFF_MAIL_HOOK: HOOK,
    RESEND_API_KEY: "re_test",
    RESEND_WEBHOOK_SECRET: `whsec_${SVIX_SECRET}`,
    STAFF_MAIL_WEBHOOK_SECRET: "posta-test-secret",
    SENT: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => void kv.set(key, value) },
  }) as unknown as Env;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const next = (replies: Reply[], fallback: () => Response) => {
  const reply = replies.shift() ?? fallback();
  if (reply instanceof Error) throw reply;
  return reply;
};

afterEach(() => mock.restoreAll());

beforeEach(() => {
  kv = new Map();
  calls = [];
  hookReplies = [];
  sendReplies = [];
  email = {
    object: "email",
    id: "e1",
    from: "Ola <ola@example.com>",
    to: ["staff@zagrajmy.net"],
    cc: null,
    received_for: ["staff@zagrajmy.net"],
    subject: "Zgłoszenie",
    text: "Ktoś prosi mojego brata o telefon.",
    html: null,
    headers: { from: "Ola <ola@example.com>" },
    message_id: "<abc@mail.example>",
    reply_to: null,
    raw: { download_url: RAW, expires_at: "2026-11-14T00:00:00Z" },
    attachments: [],
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  };
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = request.url.split("?")[0]!;
    calls.push({ url, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
    if (url === "https://api.resend.com/emails/receiving/e1") return json(email);
    if (url === "https://api.resend.com/emails/receiving/e1/attachments") return json({ object: "list", has_more: false, data: [] });
    if (url === "https://api.resend.com/emails") return next(sendReplies, () => json({ id: `sent-${calls.length}` }));
    if (url === RAW) return new Response(raw);
    if (url === HOOK) return next(hookReplies, () => json({ outcome: "opened", case: "Z-1" }));
    throw new Error(`unexpected fetch ${url}`);
  });
});

/** One Resend webhook delivery; a throw is what Resend sees as a 500 and retries. */
async function deliver() {
  const payload = JSON.stringify({ type: "email.received", created_at: "2026-11-13T10:00:00Z", data: { email_id: "e1" } });
  const id = "msg_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", Buffer.from(SVIX_SECRET, "base64"))
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  const request = new Request("https://posta.zagrajmy.net", {
    method: "POST",
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` },
    body: payload,
  });
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], env()).then(
    (response) => response.status,
    () => 500,
  );
}

const forwarded = () =>
  calls.filter((c) => c.url === "https://api.resend.com/emails").map((c) => JSON.parse(new TextDecoder().decode(c.body)).to);
const handedOff = () => calls.filter((c) => c.url === HOOK);

test("staff@ mail reaches both owners and Django, signed, with attachment bytes stripped", async () => {
  assert.equal(await deliver(), 204);
  assert.deepEqual(forwarded().sort(), OWNERS);

  const [hook, ...more] = handedOff();
  assert.ok(hook);
  assert.equal(more.length, 0);
  assert.equal(hook.headers.get("content-type"), "message/rfc822");
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(hook.headers.get("x-posta-signature") ?? "") ?? [];
  assert.ok(Math.abs(Number(t) - Date.now() / 1000) < 5);
  assert.equal(v1, createHmac("sha256", "posta-test-secret").update(`${t}.`).update(hook.body).digest("hex"));
  const body = new TextDecoder().decode(hook.body);
  assert.ok(body.includes("Ktoś prosi mojego brata o telefon."));
  assert.ok(body.includes('name="umowa.pdf"'));
  assert.ok(!body.includes("JVBERi0x"));
});

test("only an envelope recipient of staff@ is handed off, never a Cc", async () => {
  for (const [received_for, to, cc] of [
    [["piotr@zagrajmy.net"], ["piotr@zagrajmy.net"], ["staff@zagrajmy.net"]],
    [["kontakt@zagrajmy.net"], ["kontakt@zagrajmy.net"], null],
  ]) {
    Object.assign(email, { received_for, to, cc });
    kv.clear();
    assert.equal(await deliver(), 204);
  }
  assert.equal(handedOff().length, 0);
  assert.equal(forwarded().length, 3);

  Object.assign(email, { received_for: ["Staff+Zgloszenia@Zagrajmy.net"], to: ["x@zagrajmy.net"], cc: null });
  assert.equal(await deliver(), 204);
  assert.equal(handedOff().length, 1);
});

for (const [name, reply] of [
  ["500", json({}, 500)],
  ["502 from the proxy", new Response("bad gateway", { status: 502 })],
  ["404 before Django has the hook", new Response("not found", { status: 404 })],
  ["429", new Response(null, { status: 429 })],
  ["a redirect to a login page", new Response(null, { status: 302, headers: { location: "/login" } })],
  ["400", new Response("bad request", { status: 400 })],
  ["a network error", new TypeError("fetch failed")],
] as const) {
  test(`a hand-off failing with ${name} is retried on redelivery without forwarding twice`, async () => {
    hookReplies.push(reply);
    assert.equal(await deliver(), 500);
    assert.equal(forwarded().length, 2);

    assert.equal(await deliver(), 204);
    assert.equal(await deliver(), 204);
    assert.equal(forwarded().length, 2);
    assert.equal(handedOff().length, 2);
  });
}

for (const status of [401, 413, 422]) {
  test(`a hand-off refused with ${status} isn't retried`, async () => {
    hookReplies.push(json({ error: "refused" }, status));
    assert.equal(await deliver(), 204);
    assert.equal(await deliver(), 204);
    assert.equal(handedOff().length, 1);
    assert.equal(forwarded().length, 2);
  });
}

test("a failed forward doesn't hold up the hand-off, and redelivery retries only the forward", async () => {
  sendReplies.push(json({ name: "application_error", message: "down", statusCode: 500 }, 500));
  assert.equal(await deliver(), 500);
  assert.equal(handedOff().length, 1);
  assert.equal(forwarded().length, 2);

  assert.equal(await deliver(), 204);
  assert.equal(handedOff().length, 1);
  assert.equal(forwarded().length, 3);
});

test("a message Resend has no raw copy of yet is retried", async () => {
  email.raw = null;
  assert.equal(await deliver(), 500);
  assert.equal(forwarded().length, 2);
  assert.equal(handedOff().length, 0);
});

test("DMARC failures are neither forwarded nor handed off", async () => {
  email.authentication = { spf: "fail", dkim: "fail", dmarc: "fail" };
  assert.equal(await deliver(), 204);
  assert.equal(calls.length, 1);
});
