/** Local part → destination addresses. `"*"` is the catch-all. */
export type Routes = { "*": readonly string[] } & Record<string, readonly string[]>;

/**
 * Local parts on `domain` among `recipients`, lowercased and without `+tags`.
 * One that can't be a From address reads as postmaster.
 */
export function locals({ recipients, domain }: { recipients: string[]; domain: string }) {
  const suffix = `@${domain}`;
  return recipients
    .map((r) => (/<([^>]*)>/.exec(r)?.[1] ?? r).trim().toLowerCase())
    .filter((r) => r.endsWith(suffix))
    .map((r) => r.slice(0, -suffix.length).split("+")[0]!)
    .map((local) => (/^[a-z0-9._-]+$/.test(local) ? local : "postmaster"));
}

/** Destination → local part it was addressed to, one entry per destination. */
export function route({ recipients, routes, domain }: { recipients: string[]; routes: Routes; domain: string }) {
  const addressed = locals({ recipients, domain });
  if (!addressed.length) addressed.push("postmaster");

  const out = new Map<string, string>();
  for (const local of addressed)
    for (const destination of Object.hasOwn(routes, local) ? routes[local]! : routes["*"])
      if (!out.has(destination)) out.set(destination, local);
  return out;
}
