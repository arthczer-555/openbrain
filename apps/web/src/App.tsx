import { useCallback, useEffect, useState } from "react";
import type { PublicConfig } from "@openbrain/server/protocol";
import { api } from "./lib/api.ts";
import { navigate, useRoute } from "./lib/router.tsx";
import { applyTheme } from "./lib/theme.ts";
import { Admin } from "./pages/Admin.tsx";
import { Chat } from "./pages/Chat.tsx";
import { Knowledge } from "./pages/Knowledge.tsx";
import { Login } from "./pages/Login.tsx";

export function App() {
  const route = useRoute();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    api.config().then(
      (c) => {
        setConfig(c);
        applyTheme(c.accent);
        document.title = c.assistantName;
      },
      () => setFailed(true),
    );
  }, []);
  useEffect(load, [load]);

  const signedIn = config?.user !== null && config !== null;
  useEffect(() => {
    if (!config) return;
    if (!signedIn && route.path !== "/login") navigate(`/login${route.path === "/" ? "" : `?next=${encodeURIComponent(route.path + window.location.search)}`}`, true);
    if (signedIn && route.path === "/login") {
      const next = route.query.get("next");
      navigate(next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/", true);
    }
  }, [config, signedIn, route.path, route.query]);

  if (failed) {
    return (
      <div className="center-page">
        <div className="login-card">
          <h1>
            The server cannot be reached<span className="caret">_</span>
          </h1>
          <p className="fine">Check your connection, then reload the page.</p>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
  if (!config) {
    return (
      <div className="loading">
        <div className="spinner" />
      </div>
    );
  }
  if (route.path === "/login" || !signedIn) return <Login config={config} onSignedIn={load} />;
  if (route.path.startsWith("/admin")) return <Admin config={config} onSignedIn={load} />;
  if (route.path === "/kb") return <Knowledge config={config} />;
  return <Chat config={config} />;
}
