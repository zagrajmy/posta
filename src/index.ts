import { addressParser } from "postal-mime";
import { Resend, type ErrorResponse, type GetReceivingEmailResponseSuccess } from "resend";
import { route } from "./routing.ts";

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
  const got = await resend.emails.receiving.get(emailId, { html_format: "cid" });
  if (got.error) throw new Error(`get ${emailId}: ${got.error.message}`);
  const email = got.data as ReceivedEmail;
  const meta = { emailId, from: email.from, to: email.to, subject: email.subject };

  if (email.authentication?.dmarc === "fail") {
    console.warn({ event: "dropped_dmarc_fail", ...meta, authentication: email.authentication });
    return;
  }

  const listed = await resend.emails.receiving.attachments.list({ emailId, limit: 100 });
  if (listed.error) throw new Error(`attachments ${emailId}: ${listed.error.message}`);
  if (listed.data.has_more) console.warn({ event: "attachments_truncated", ...meta, kept: listed.data.data.length });

  const senderName = addressParser(email.headers?.["from"] ?? "")[0]?.name || email.from;
  const subject = email.subject || "(no subject)";
  const message = {
    replyTo: email.reply_to?.length ? email.reply_to : email.from,
    subject,
    ...(email.html ? { html: email.html, text: email.text ?? undefined } : { text: email.text ?? "(empty message)" }),
    attachments: listed.data.data.length
      ? listed.data.data.map((a) => ({
          path: a.download_url,
          filename: a.filename,
          contentType: a.content_type,
          contentId: a.content_id?.replace(/^<|>$/g, "") || undefined,
        }))
      : undefined,
    headers: threading(email),
  };

  const destinations = route({
    recipients: [...email.to, ...(email.cc ?? []), ...(email.bcc ?? []), ...email.received_for],
    routes: env.ROUTES,
    domain: env.DOMAIN,
  });

  const deliveries = await Promise.allSettled(
    [...destinations].map(async ([to, local]) => {
      const done = `${emailId}/${to}`;
      if (await env.SENT.get(done)) {
        console.log({ event: "already_forwarded", ...meta, local, destination: to });
        return;
      }
      const markDone = (how: string) => env.SENT.put(done, how, { expirationTtl: 7 * 24 * 60 * 60 });

      const sent = await resend.emails.send(
        { ...message, from: `${phrase(`${senderName} via Zagrajmy`)} <${local}@${env.DOMAIN}>`, to },
        { idempotencyKey: `forward/${emailId}/${to}` },
      );
      const result = outcome(sent.error);
      if (result === "retry") throw new Error(`send ${emailId} → ${to}: ${sent.error?.message}`);
      if (result === "sent") {
        console.log({ event: "forwarded", ...meta, local, destination: to, sentId: sent.data?.id ?? sent.error?.name });
        await markDone("forwarded");
        return;
      }

      console.error({ event: "forward_failed", ...meta, local, destination: to, error: sent.error });
      const notice = await resend.emails.send(
        {
          from: `Zagrajmy <postmaster@${env.DOMAIN}>`,
          to,
          subject: `Couldn't forward: ${subject}`,
          text: [
            `A message from ${email.from} to ${local}@${env.DOMAIN} couldn't be forwarded.`,
            `Reason: ${sent.error?.message}`,
            `The original is in Resend → Emails → Receiving (id: ${emailId}).`,
          ].join("\n"),
        },
        { idempotencyKey: `notice/${emailId}/${to}` },
      );
      if (outcome(notice.error) !== "sent") throw new Error(`notice ${emailId} → ${to}: ${notice.error?.message}`);
      await markDone("noticed");
    }),
  );
  const failure = deliveries.find((d) => d.status === "rejected");
  if (failure) throw failure.reason;
}

/**
 * A retried webhook re-lists attachments, which signs fresh download URLs, so a send that already
 * went out comes back as `invalid_idempotent_request` rather than replaying the original response.
 */
function outcome(error: ErrorResponse | null): "sent" | "retry" | "failed" {
  if (!error || error.name === "invalid_idempotent_request") return "sent";
  const { name, statusCode } = error;
  if (name === "concurrent_idempotent_requests" || statusCode === null || statusCode === 429 || statusCode >= 500)
    return "retry";
  return "failed";
}

/** RFC 5322 quoted display name, with anything that could break out of it removed. */
function phrase(name: string) {
  return `"${name.replace(/["\\\r\n<>]/g, "")}"`;
}

/** Keeps the forward in the sender's thread, so replies from the destination thread for them too. */
function threading(email: ReceivedEmail): Record<string, string> {
  const unfold = (value: string | undefined) => value?.replace(/\s+/g, " ").trim() || undefined;
  const references = unfold([email.headers?.["references"], email.message_id].filter(Boolean).join(" "));
  const inReplyTo = unfold(email.headers?.["in-reply-to"]);
  return { ...(references && { References: references }), ...(inReplyTo && { "In-Reply-To": inReplyTo }) };
}
