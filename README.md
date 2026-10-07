# posta

Inbound mail for `@zagrajmy.net`. Resend receives it (root MX), fires an
`email.received` webhook at this Cloudflare Worker, and the Worker forwards each
message to its owners.

- Sent `From: "Jan Kowalski via Zagrajmy" <alias@zagrajmy.net>`, with `Reply-To` set
  to the original sender, so replies go straight to them and Gmail filters can
  match on the alias.
- Attachments and inline images go through as Resend-fetched URLs; their bytes
  never pass through the Worker.
- DMARC failures are dropped. They stay visible in Resend → Emails → Receiving.
- Transient errors return 500 so Resend retries. A KV record per
  destination (`SENT`, kept 7 days) stops duplicates; Resend's own
  idempotency keys alone let one through on replay. Permanent errors (for example, over 40 MB) send the recipient a
  notice instead.

## Routing

`vars.ROUTES` in `wrangler.jsonc`: local part → destinations, `"*"` is the
catch-all. Case and `+tags` are ignored. Destinations on `zagrajmy.net` are
rejected (loop).

## Develop

```sh
pnpm install
pnpm test        # routing
pnpm typecheck
pnpm dev         # needs .dev.vars with the two secrets
```

## Deploy

Pushing to `main` deploys. Cloudflare Workers Builds runs `pnpm typecheck &&
pnpm test`, then `pnpm wrangler deploy` (Cloudflare → Workers → posta →
Settings → Builds; `NODE_VERSION=24` is set there).

Secrets live only on the Worker:

```sh
pnpm wrangler secret put RESEND_API_KEY        # full access: receiving API + send
pnpm wrangler secret put RESEND_WEBHOOK_SECRET # from the Resend webhook page
```

Deploying from a laptop still works with `pnpm wrangler deploy` (not
`pnpm deploy`, which is pnpm's own command).

Resend → Webhooks → add endpoint `https://posta.zagrajmy.net`,
event `email.received`. Logs: Cloudflare → Workers → posta → Logs.

Before touching DNS, test end-to-end by mailing `anything@<id>.resend.app`
(Resend → Emails → Receiving → ⋯ → Receiving address); it lands in the
catch-all.
