import { Resend, type GetReceivingEmailResponseSuccess } from "resend";
import { checkRoutes, route } from "./routing.ts";

// NOTE: the API returns `authentication`; resend@6 types don't declare it yet.
type ReceivedEmail = GetReceivingEmailResponseSuccess & {
  authentication?: { spf: string; dkim: string; dmarc: string } | null;
};

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("posta forwards Resend inbound webhooks\n", { status: 405 });

    const resend = new Resend(env.RESEND_API_KEY);
    const payload = await request.text();
    let event;
    try {
      event = resend.webhooks.verify({
        payload,
        headers: {
          id: request.headers.get("svix-id") ?? "",
          timestamp: request.headers.get("svix-timestamp") ?? "",
          signature: request.headers.get("svix-signature") ?? "",
        },
        webhookSecret: env.RESEND_WEBHOOK_SECRET,
      });
    } catch (error) {
      console.warn({ event: "webhook_rejected", reason: String(error) });
      return new Response("invalid signature", { status: 401 });
    }
    if (event.type !== "email.received") return new Response(null, { status: 204 });

    await forward({ resend, env, emailId: event.data.email_id });
    return new Response(null, { status: 204 });
  },
} satisfies ExportedHandler<Env>;

async function forward({ resend, env, emailId }: { resend: Resend; env: Env; emailId: string }) {
  const domain = env.DOMAIN;
  const routes = checkRoutes(env.ROUTES, domain);

  const got = await resend.emails.receiving.get(emailId, { html_format: "cid" });
  if (got.error) throw new Error(`get ${emailId}: ${got.error.message}`);
  const email = got.data as ReceivedEmail;
  const sender = email.headers?.["from"] ?? email.from;
  const meta = { emailId, from: email.from, to: email.to, subject: email.subject };

  if (email.authentication?.dmarc === "fail") {
    console.warn({ event: "dropped_dmarc_fail", ...meta, authentication: email.authentication });
    return;
  }

  const listed = await resend.emails.receiving.attachments.list({ emailId, limit: 100 });
  if (listed.error) throw new Error(`attachments ${emailId}: ${listed.error.message}`);
  if (listed.data.has_more) console.warn({ event: "attachments_truncated", ...meta, kept: listed.data.data.length });
  const attachments = listed.data.data.map((a) => ({
    path: a.download_url,
    filename: a.filename,
    contentType: a.content_type,
    contentId: a.content_id ?? undefined,
  }));

  const destinations = route({
    recipients: [...email.to, ...(email.cc ?? []), ...(email.bcc ?? []), ...email.received_for],
    routes,
    domain,
  });
  const subject = email.subject || "(no subject)";

  for (const [to, local] of destinations) {
    const sent = await resend.emails.send(
      {
        from: `${phrase(`${displayName(sender)} via Zagrajmy`)} <${local}@${domain}>`,
        to,
        replyTo: email.headers?.["reply-to"] ?? sender,
        subject,
        ...(email.html
          ? { html: email.html, text: email.text ?? undefined }
          : { text: email.text ?? "(empty message)" }),
        attachments: attachments.length ? attachments : undefined,
        headers: threading(email),
      },
      { idempotencyKey: `forward/${emailId}/${to}` },
    );
    if (!sent.error) {
      console.log({ event: "forwarded", ...meta, local, destination: to, sentId: sent.data.id });
      continue;
    }
    if (isRetryable(sent.error.statusCode)) throw new Error(`send ${emailId} → ${to}: ${sent.error.message}`);

    console.error({ event: "forward_failed", ...meta, local, destination: to, error: sent.error });
    const notice = await resend.emails.send(
      {
        from: `Zagrajmy <postmaster@${domain}>`,
        to,
        subject: `Couldn't forward: ${subject}`,
        text: [
          `A message from ${sender} to ${local}@${domain} couldn't be forwarded.`,
          `Reason: ${sent.error.message}`,
          `The original is in Resend → Emails → Receiving (id: ${emailId}).`,
        ].join("\n"),
      },
      { idempotencyKey: `notice/${emailId}/${to}` },
    );
    if (notice.error) throw new Error(`notice ${emailId} → ${to}: ${notice.error.message}`);
  }
}

function isRetryable(status: number | null) {
  return status === null || status === 429 || status >= 500;
}

/** `Jan Kowalski <jan@example.com>` → `Jan Kowalski`; bare address stays as is. */
function displayName(from: string) {
  const match = /^\s*"?(.*?)"?\s*<[^>]*>\s*$/.exec(from);
  return match?.[1] || from.trim();
}

/** RFC 5322 quoted display name, with anything that could break out of it removed. */
function phrase(name: string) {
  return `"${name.replace(/["\\\r\n<>]/g, "")}"`;
}

/** Keeps the forward in the sender's thread, so replies from the destination thread for them too. */
function threading(email: ReceivedEmail): Record<string, string> {
  const references = [email.headers?.["references"], email.message_id].filter(Boolean).join(" ");
  const inReplyTo = email.headers?.["in-reply-to"];
  return { ...(references && { References: references }), ...(inReplyTo && { "In-Reply-To": inReplyTo }) };
}
