/** Local part → destination addresses. `"*"` is the catch-all. */
export type Routes = Record<string, string[]>;

export function parseRoutes(json: string, domain: string): Routes {
  const routes: unknown = JSON.parse(json);
  if (typeof routes !== "object" || routes === null) throw new Error("ROUTES must be a JSON object");
  for (const [local, destinations] of Object.entries(routes)) {
    if (!Array.isArray(destinations) || !destinations.every((d) => typeof d === "string" && d.includes("@")))
      throw new Error(`ROUTES.${local} must be an array of email addresses`);
    for (const d of destinations)
      if (d.toLowerCase().endsWith(`@${domain}`)) throw new Error(`ROUTES.${local} → ${d} would loop back into ${domain}`);
  }
  if (!(routes as Routes)["*"]?.length) throw new Error('ROUTES needs a non-empty "*" catch-all');
  return routes as Routes;
}

/** Destination → local part it was addressed to, one entry per destination. */
export function route({ recipients, routes, domain }: { recipients: string[]; routes: Routes; domain: string }) {
  const suffix = `@${domain}`;
  const locals = recipients
    .map((r) => (/<([^>]*)>/.exec(r)?.[1] ?? r).trim().toLowerCase())
    .filter((r) => r.endsWith(suffix))
    .map((r) => r.slice(0, -suffix.length).split("+")[0]!);
  if (!locals.length) locals.push("postmaster");

  const out = new Map<string, string>();
  for (const local of locals)
    for (const destination of Object.hasOwn(routes, local) ? routes[local]! : routes["*"]!)
      if (!out.has(destination)) out.set(destination, local);
  return out;
}
