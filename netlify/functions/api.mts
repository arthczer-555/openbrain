import { handle, type NetlifyContext } from "../lib/runtime.ts";

// Every other /api route: config, auth, feedback, knowledge browser, admin (reports and models).

export default (request: Request, context: NetlifyContext): Promise<Response> => handle(request, context);

export const config = {
  path: "/api/*",
  excludedPath: ["/api/chat"],
};
