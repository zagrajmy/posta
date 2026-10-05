import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRoutes, route } from "./routing.ts";

const domain = "zagrajmy.net";
const routes = checkRoutes(
  { piotr: ["p@example.com"], radek: ["r@example.org"], "*": ["p@example.com", "r@example.org"] },
  domain,
);
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

test("routes without catch-all are rejected", () => {
  assert.throws(() => checkRoutes({ piotr: ["p@example.com"] }, domain), /catch-all/);
});

test("routes forwarding back into our domain are rejected", () => {
  assert.throws(() => checkRoutes({ "*": ["Kontakt@Zagrajmy.net"] }, domain), /loop/);
});
