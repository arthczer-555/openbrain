import { readCookie, SESSION_COOKIE, verifySession } from "../../packages/server/src/session.ts";

// Edge guard: a page of the chatbot is only served with a valid session cookie; other
// visitors land on /login. The API checks the session again on every call, this is the outer door.
// Runs on Deno: only Web APIs, the session code is shared with the server (packages/server/src/session.ts).

declare const Netlify: { env: { get(key: string): string | undefined } };

interface EdgeContext {
  next(): Promise<Response>;
}

const PUBLIC = [/^\/login\/?$/, /^\/assets\//, /^\/favicon\.svg$/, /^\/robots\.txt$/];

export default async (request: Request, context: EdgeContext): Promise<Response> => {
  const url = new URL(request.url);
  // Off when the site is protected by Netlify itself (auth mode "netlify") or for a public demo with fake data.
  if (Netlify.env.get("OPENBRAIN_EDGE_GUARD") === "off" || PUBLIC.some((re) => re.test(url.pathname))) return context.next();
  const secret = Netlify.env.get("SESSION_SECRET") ?? "";
  const session = await verifySession(readCookie(request.headers.get("cookie"), SESSION_COOKIE), secret);
  if (session) return context.next();
  const next = url.pathname === "/" ? "" : `?next=${encodeURIComponent(url.pathname + url.search)}`;
  return Response.redirect(new URL(`/login${next}`, url), 302);
};

export const config = {
  path: "/*",
  excludedPath: ["/api/*"],
};
