import type {
  ApiError,
  ChatRequest,
  ChatStreamEvent,
  FeedbackRequest,
  FeedbackResponse,
  KbIndex,
  KbPage,
  ModelsResponse,
  ModelTestResponse,
  PublicConfig,
  ReportsResponse,
  ReportStatus,
  SessionUser,
  UpdateModelsRequest,
} from "@openbrain/server/protocol";

// Typed client of the chatbot API (packages/server/src/protocol.ts).

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    credentials: "same-origin",
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
}

async function failure(response: Response): Promise<ApiFailure> {
  try {
    const body = (await response.json()) as ApiError;
    return new ApiFailure(response.status, body.error.code, body.error.message);
  } catch {
    return new ApiFailure(response.status, "http_error", `request failed (${response.status})`);
  }
}

const post = <T>(path: string, body: unknown): Promise<T> => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  config: () => call<PublicConfig>("/api/config"),
  login: (code: string) => post<{ user: SessionUser }>("/api/auth/login", { code }),
  adminLogin: (code: string) => post<{ user: SessionUser }>("/api/auth/admin", { code }),
  logout: () => post<{ ok: true }>("/api/auth/logout", {}),
  feedback: (body: FeedbackRequest) => post<FeedbackResponse>("/api/feedback", body),
  kb: () => call<KbIndex>("/api/kb"),
  kbPage: (id: string) => call<KbPage>(`/api/kb/page?id=${encodeURIComponent(id)}`),
  reports: (filter: { type?: string; status?: string }) => {
    const query = new URLSearchParams(Object.entries(filter).filter((e): e is [string, string] => Boolean(e[1])));
    return call<ReportsResponse>(`/api/admin/reports?${query.toString()}`);
  },
  markReports: (ids: string[], status: ReportStatus) => post<{ ok: true; changed: number }>("/api/admin/reports/mark", { ids, status }),
  models: () => call<ModelsResponse>("/api/admin/models"),
  updateModels: (body: UpdateModelsRequest) => post<{ ok: true }>("/api/admin/models", body),
  testModel: (model: string) => post<ModelTestResponse>("/api/admin/models/test", { model }),
};

/** POST /api/chat and yield its Server-Sent Events (EventSource cannot POST). */
export async function* streamChat(body: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    signal,
  });
  if (!response.ok || !response.body) throw await failure(response);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (data) yield JSON.parse(data) as ChatStreamEvent;
      boundary = buffer.indexOf("\n\n");
    }
  }
}
