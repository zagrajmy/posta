import type { Meta } from "./index.ts";

/** Local part whose mail also goes to Zagrajmy's staff case inbox. */
export const STAFF = "staff";

/**
 * Posts the raw message to Django's `/hooks/staff-mail`. A KV record per email stops a redelivered
 * webhook from posting again once Django took or refused it; until then each redelivery retries.
 */
export async function handOff({ env, emailId, rawUrl, meta }: { env: Env; emailId: string; rawUrl?: string; meta: Meta }) {
  const done = `${emailId}/staff-hook`;
  if (await env.SENT.get(done)) {
    console.log({ event: "already_handed_off", ...meta });
    return;
  }
  const retry = (reason: string | number): never => {
    console.warn({ event: "handoff_retry", ...meta, reason });
    throw new Error(`hand-off ${emailId}: ${reason}`);
  };

  if (!rawUrl) return retry("no raw message");
  let response: Response;
  try {
    const download = await fetch(rawUrl, { signal: AbortSignal.timeout(15_000) });
    if (!download.ok) return retry(`raw message ${download.status}`);
    const body = stripAttachments(new Uint8Array(await download.arrayBuffer()));
    response = await fetch(env.STAFF_MAIL_HOOK, {
      method: "POST",
      headers: {
        "Content-Type": "message/rfc822",
        "X-Posta-Signature": await sign({ secret: env.STAFF_MAIL_WEBHOOK_SECRET, timestamp: Date.now() / 1000, body }),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return retry(String(error));
  }

  const reply = (await response.json().catch(() => null)) as { outcome?: string; case?: string; error?: string } | null;
  if (response.ok) {
    console.log({ event: "handed_off", ...meta, outcome: reply?.outcome, case: reply?.case });
    await markDone(env, done, reply?.outcome ?? "handed off");
    return;
  }
  if (!REFUSED.has(response.status)) return retry(response.status);
  console.error({ event: "handoff_refused", ...meta, status: response.status, error: reply?.error });
  await markDone(env, done, `refused ${response.status}`);
}

const markDone = (env: Env, key: string, how: string) => env.SENT.put(key, how, { expirationTtl: 7 * 24 * 60 * 60 });

/** Refusals of the message itself; anything else (5xx, a 404 before the hook is deployed, a proxy's 403) may pass later. */
const REFUSED = new Set([401, 413, 422]);

/** `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + body)>`, as `ludamus.gates.web.django.staff.mail` checks it. */
export async function sign({ secret, timestamp, body }: { secret: string; timestamp: number; body: Uint8Array }) {
  const t = Math.floor(timestamp);
  const prefix = new TextEncoder().encode(`${t}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  return `t=${t},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Empties every part that isn't a plain or HTML body, keeping its headers so Django still names it.
 * Django stores attachment names only, and refuses a message over its upload limit.
 * Works on the bytes, so a 40 MB message costs one copy of what's kept.
 */
export function stripAttachments(raw: Uint8Array): Uint8Array {
  const kept: Uint8Array[] = [];
  strip(raw, kept);
  const out = new Uint8Array(kept.reduce((n, chunk) => n + chunk.length, 0));
  let at = 0;
  for (const chunk of kept) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const [TAB, LF, CR, SPACE, DASH] = [9, 10, 13, 32, 45];

function strip(entity: Uint8Array, kept: Uint8Array[]) {
  const headEnd = headerEnd(entity);
  if (headEnd < 0) return void kept.push(entity);
  const head = entity.subarray(0, headEnd);
  const fields = ascii(head).replace(/\r?\n[ \t]+/g, " ");
  const type = field(fields, "content-type");
  const boundary = /^multipart\//i.test(type) && /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  if (boundary) {
    kept.push(head);
    return stripParts(entity.subarray(headEnd), new TextEncoder().encode(`--${boundary[1] ?? boundary[2]}`), kept);
  }
  const body = (!type || /^text\/(?:plain|html)\b/i.test(type)) && !/^attachment\b/i.test(field(fields, "content-disposition"));
  kept.push(body ? entity : head);
}

/** The line break before a delimiter belongs to it; text after a closing delimiter stays as it is. */
function stripParts(body: Uint8Array, dashBoundary: Uint8Array, kept: Uint8Array[]) {
  let from = 0;
  let inPart = false;
  for (const { start, end, close } of delimiters(body, dashBoundary)) {
    if (inPart) strip(body.subarray(from, start), kept);
    else kept.push(body.subarray(from, start));
    kept.push(body.subarray(start, end));
    from = end;
    inPart = !close;
    if (close) break;
  }
  if (inPart) strip(body.subarray(from), kept);
  else kept.push(body.subarray(from));
}

function* delimiters(body: Uint8Array, dashBoundary: Uint8Array) {
  for (let line = 0; line < body.length; line = body.indexOf(LF, line) + 1 || body.length) {
    if (!dashBoundary.every((byte, i) => body[line + i] === byte)) continue;
    let end = line + dashBoundary.length;
    const close = body[end] === DASH && body[end + 1] === DASH;
    if (close) end += 2;
    while (body[end] === SPACE || body[end] === TAB) end++;
    if (body[end] === CR && body[end + 1] === LF) end += 2;
    else if (body[end] === LF) end++;
    else if (end < body.length) continue;
    const start = line === 0 ? 0 : line >= 2 && body[line - 2] === CR ? line - 2 : line - 1;
    yield { start, end, close };
  }
}

/** Index just past the blank line ending the headers, or -1. */
function headerEnd(entity: Uint8Array) {
  for (let line = 0; line < entity.length; line = entity.indexOf(LF, line) + 1 || entity.length) {
    if (entity[line] === LF) return line + 1;
    if (entity[line] === CR && entity[line + 1] === LF) return line + 2;
  }
  return -1;
}

/** Headers are ASCII; other bytes only need to stay out of the way of the patterns. */
function ascii(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return text;
}

function field(fields: string, name: string) {
  return new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(fields)?.[1]?.trim() ?? "";
}
