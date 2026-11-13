/** Local part whose mail also goes to Zagrajmy's staff case inbox. */
export const STAFF = "staff";

type Meta = Record<string, unknown>;

/**
 * Posts the raw message to Django's `/hooks/staff-mail`. A KV record per email stops a redelivered
 * webhook from posting again once Django took or refused it; until then each redelivery retries.
 */
export async function handOff({ env, emailId, rawUrl, meta }: { env: Env; emailId: string; rawUrl?: string; meta: Meta }) {
  const done = `${emailId}/${STAFF}-hook`;
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
  if (retryable(response.status)) return retry(response.status);
  console.error({ event: "handoff_refused", ...meta, status: response.status, error: reply?.error });
  await markDone(env, done, `refused ${response.status}`);
}

const markDone = (env: Env, key: string, how: string) => env.SENT.put(key, how, { expirationTtl: 7 * 24 * 60 * 60 });

/** 404 too: the hook answers it until Django is deployed with the secret. */
export function retryable(status: number) {
  return status >= 500 || status === 404 || status === 408 || status === 429;
}

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
 */
export function stripAttachments(raw: Uint8Array): Uint8Array {
  // NOTE: one char per byte, so 8-bit bodies come back byte for byte.
  let binary = "";
  for (let i = 0; i < raw.length; i += 0x8000) binary += String.fromCharCode(...raw.subarray(i, i + 0x8000));
  return Uint8Array.from(strip(binary), (c) => c.charCodeAt(0));
}

function strip(entity: string): string {
  const blank = /(?:^|\r?\n)\r?\n/.exec(entity);
  if (!blank) return entity;
  const head = entity.slice(0, blank.index + blank[0].length);
  const type = field(head, "content-type");
  const boundary = /^multipart\//i.test(type) && /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  if (boundary) return head + stripParts(entity.slice(head.length), boundary[1] ?? boundary[2]!);
  const body = (!type || /^text\/(?:plain|html)\b/i.test(type)) && !/^attachment\b/i.test(field(head, "content-disposition"));
  return body ? entity : head;
}

function stripParts(body: string, boundary: string): string {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const delimiter = new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, "g");
  let out = "";
  let from = 0;
  let inPart = false;
  for (const match of body.matchAll(delimiter)) {
    const segment = body.slice(from, match.index);
    out += (inPart ? strip(segment) : segment) + match[0];
    from = match.index + match[0].length;
    inPart = !match[1];
    if (!inPart) break;
  }
  const rest = body.slice(from);
  return out + (inPart ? strip(rest) : rest);
}

function field(head: string, name: string) {
  return new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(head.replace(/\r?\n[ \t]+/g, " "))?.[1]?.trim() ?? "";
}
