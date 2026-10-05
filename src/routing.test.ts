import assert from "node:assert/strict";
import { test } from "node:test";
import { unstable_readConfig } from "wrangler";
import { route, type Routes } from "./routing.ts";

const domain = "zagrajmy.net";
const routes: Routes = { piotr: ["p@example.com"], radek: ["r@example.org"], "*": ["p@example.com", "r@example.org"] };
const run = (...recipients: string[]) => Object.fromEntries(route({ recipients, routes, domain }));

test("named alias goes only to its owner", () => {
  assert.deepEqual(run("radek@zagrajmy.net"), { "r@example.org": "radek" });
});

test("unknown local part falls through to catch-all", () => {
  assert.deepEqual(run("team@zagrajmy.net"), { "p@example.com": "team", "r@example.org": "team" });
});

test("case, whitespace and +tags don't defeat aliases", () => {
  assert.deepEqual(run(" Piotr+konwent@Zagrajmy.NET "), { "p@example.com": "piotr" });
});

test("display names around addresses are ignored", () => {
  assert.deepEqual(run('"Radek" <radek@zagrajmy.net>'), { "r@example.org": "radek" });
});

test("foreign recipients are ignored and each destination gets one copy", () => {
  assert.deepEqual(run("someone@gmail.com", "piotr@zagrajmy.net", "kontakt@zagrajmy.net"), {
    "p@example.com": "piotr",
    "r@example.org": "kontakt",
  });
});

test("mail with no recipient on our domain still reaches catch-all", () => {
  assert.deepEqual(run("someone@gmail.com"), { "p@example.com": "postmaster", "r@example.org": "postmaster" });
});

test("prototype keys are plain unknown aliases", () => {
  assert.deepEqual(run("constructor@zagrajmy.net"), { "p@example.com": "constructor", "r@example.org": "constructor" });
});

test("lookalike domains don't match", () => {
  assert.deepEqual(run("piotr@notzagrajmy.net"), { "p@example.com": "postmaster", "r@example.org": "postmaster" });
});

test("local parts that can't be a From address fall back to postmaster", () => {
  assert.deepEqual(run("+promo@zagrajmy.net", '"a b"@zagrajmy.net'), { "p@example.com": "postmaster", "r@example.org": "postmaster" });
});

test("deployed ROUTES have a catch-all and never forward back into our domain", () => {
  const { DOMAIN, ROUTES } = unstable_readConfig({ config: "wrangler.jsonc" }).vars as { DOMAIN: string; ROUTES: Routes };
  assert.ok(ROUTES["*"].length);
  for (const destination of Object.values(ROUTES).flat()) {
    assert.match(destination, /^[^@\s]+@[^@\s]+$/);
    assert.ok(!destination.toLowerCase().endsWith(`@${DOMAIN}`), `${destination} loops`);
  }
});
