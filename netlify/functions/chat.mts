import { handle, type NetlifyContext } from "../lib/runtime.ts";

// POST /api/chat: one answer streamed as Server-Sent Events. Its own function so the
// native rate limit applies to it only: 20 requests per minute per IP.

export default (request: Request, context: NetlifyContext): Promise<Response> => handle(request, context);

export const config = {
  path: "/api/chat",
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
