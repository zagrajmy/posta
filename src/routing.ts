/** Local part → destination addresses. `"*"` is the catch-all. */
export type Routes = { "*": readonly string[] } & Record<string, readonly string[]>;

/** Destination → local part it was addressed to, one entry per destination. */
export function route({ recipients, routes, domain }: { recipients: string[]; routes: Routes; domain: string }) {
  const suffix = `@${domain}`;
  const locals = recipients
    .map((r) => (/<([^>]*)>/.exec(r)?.[1] ?? r).trim().toLowerCase())
    .filter((r) => r.endsWith(suffix))
    .map((r) => r.slice(0, -suffix.length).split("+")[0]!)
    .map((local) => (/^[a-z0-9._-]+$/.test(local) ? local : "postmaster"));
  if (!locals.length) locals.push("postmaster");

  const out = new Map<string, string>();
  for (const local of locals)
    for (const destination of Object.hasOwn(routes, local) ? routes[local]! : routes["*"])
      if (!out.has(destination)) out.set(destination, local);
  return out;
}
