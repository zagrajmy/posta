import assert from "node:assert/strict";
import { test } from "node:test";
import PostalMime from "postal-mime";
import { sign, stripAttachments } from "./staff-mail.ts";

const encode = (s: string) => new TextEncoder().encode(s);
const crlf = (...lines: string[]) => lines.join("\r\n");
const pdf = "JVBERi0xLjQKJcfsj6IKNSAwIG9iago8PC9MZW5ndGggNiAwIFI+PgpzdHJlYW0K".repeat(200);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA".repeat(100);

const message = crlf(
  "From: Ola W. <ola@example.com>",
  "To: staff@zagrajmy.net",
  "Subject: =?utf-8?q?Zg=C5=82oszenie?=",
  "Message-ID: <abc@mail.example>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="outer+(1)"',
  "",
  "This is a multi-part message in MIME format.",
  "--outer+(1)",
  "Content-Type: multipart/related;",
  "\tboundary=rel.2",
  "",
  "--rel.2",
  "Content-Type: multipart/alternative; boundary=alt3",
  "",
  "--alt3",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: 8bit",
  "",
  "Cześć, ktoś prosi mojego brata o telefon.",
  "--alt3",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: 8bit",
  "",
  '<p>Cześć, ktoś prosi mojego brata o telefon.</p><img src="cid:shot">',
  "--alt3--",
  "--rel.2",
  "Content-Type: image/png",
  "Content-ID: <shot>",
  'Content-Disposition: inline; filename="shot.png"',
  "Content-Transfer-Encoding: base64",
  "",
  png,
  "--rel.2--",
  "--outer+(1)",
  'Content-Type: application/pdf; name="umowa.pdf"',
  'Content-Disposition: attachment; filename="umowa.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  pdf,
  "--outer+(1)",
  "Content-Type: text/plain; charset=utf-8",
  'Content-Disposition: attachment; filename="log.txt"',
  "",
  "secret log line",
  "--outer+(1)",
  "Content-Type: message/rfc822",
  'Content-Disposition: attachment; filename="earlier.eml"',
  "",
  "Subject: earlier",
  "",
  "forwarded body",
  "--outer+(1)--",
  "",
);

test("signature is Django's HMAC-SHA256 of the timestamp and raw bytes", async () => {
  // NOTE: from ludamus.gates.web.django.staff.mail.signature(secret="posta-test-secret", timestamp=1700000000, …).
  const header = await sign({
    secret: "posta-test-secret",
    timestamp: 1_700_000_000.9,
    body: encode("Subject: Zgłoszenie\r\n\r\nCześć\r\n"),
  });
  assert.equal(header, "t=1700000000,v1=658bb30347730d7636746d15d7795721a3ed679bf45ee8017d65d803f49a0a4d");
});

test("attachments lose their bytes but keep their names; the text survives byte for byte", async () => {
  const stripped = stripAttachments(encode(message));
  const text = new TextDecoder().decode(stripped);
  for (const payload of [pdf, png, "secret log line", "forwarded body"]) assert.ok(!text.includes(payload), payload);
  assert.ok(stripped.length < 3_000, `${stripped.length} bytes`);

  const parsed = await PostalMime.parse(stripped, { rfc822Attachments: true });
  assert.equal(parsed.subject, "Zgłoszenie");
  assert.equal(parsed.messageId, "<abc@mail.example>");
  assert.equal(parsed.text?.trim(), "Cześć, ktoś prosi mojego brata o telefon.");
  assert.equal(parsed.html?.trim(), '<p>Cześć, ktoś prosi mojego brata o telefon.</p><img src="cid:shot">');
  assert.deepEqual(
    parsed.attachments.map((a) => [a.filename, a.mimeType]),
    [
      ["shot.png", "image/png"],
      ["umowa.pdf", "application/pdf"],
      ["log.txt", "text/plain"],
      ["earlier.eml", "message/rfc822"],
    ],
  );
});

test("stripping keeps everything else in place, LF line endings included", () => {
  const lf = message.replaceAll("\r\n", "\n");
  const stripped = new TextDecoder().decode(stripAttachments(encode(lf)));
  assert.ok(!stripped.includes("\r"));
  assert.ok(!stripped.includes(pdf));
  assert.ok(
    stripped.includes(
      '--outer+(1)\nContent-Type: application/pdf; name="umowa.pdf"\n' +
        'Content-Disposition: attachment; filename="umowa.pdf"\nContent-Transfer-Encoding: base64\n\n\n--outer+(1)\n',
    ),
  );
  assert.ok(stripped.startsWith(lf.slice(0, lf.indexOf("--outer+(1)\n"))));
  assert.ok(stripped.endsWith("--outer+(1)--\n"));
});

test("a plain message passes through unchanged, 8-bit bytes included", () => {
  const raw = new Uint8Array([...encode(crlf("Subject: x", "", "zażółć ")), 0xff, 0x80, 0x0d, 0x0a]);
  assert.deepEqual(stripAttachments(raw), raw);
});

test("a message that is one attachment keeps only its headers", () => {
  const head = crlf("Subject: scan", "Content-Type: image/jpeg", "Content-Transfer-Encoding: base64", "", "");
  assert.equal(new TextDecoder().decode(stripAttachments(encode(head + png))), head);
});

test("an unterminated multipart still has its last attachment stripped", () => {
  const raw = crlf(
    "Content-Type: multipart/mixed; boundary=b",
    "",
    "--b",
    "",
    "body without headers",
    "--b",
    "Content-Type: application/zip",
    "",
    pdf,
  );
  assert.equal(
    new TextDecoder().decode(stripAttachments(encode(raw))),
    crlf("Content-Type: multipart/mixed; boundary=b", "", "--b", "", "body without headers", "--b", "Content-Type: application/zip", "", ""),
  );
});
