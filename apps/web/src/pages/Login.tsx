import { useState, type FormEvent } from "react";
import type { PublicConfig } from "@openbrain/server/protocol";
import { Mark } from "../components/Logo.tsx";
import { api, ApiFailure } from "../lib/api.ts";
import { useRoute } from "../lib/router.tsx";

// Sign-in: a shared access code, or Google for companies on Google Workspace.

const GOOGLE_ERRORS: Record<string, string> = {
  state: "The sign-in took too long or was opened twice. Try again.",
  domain: "This Google account is not part of an allowed domain.",
  email: "This Google account has no verified email.",
  google: "Google refused the sign-in. Try again.",
  config: "Google sign-in is not configured on the server.",
};

export function Login({ config, onSignedIn }: { config: PublicConfig; onSignedIn: () => void }) {
  const route = useRoute();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(() => {
    const e = route.query.get("error");
    return e ? (GOOGLE_ERRORS[e] ?? "Sign-in failed.") : null;
  });
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!code.trim()) return;
    setPending(true);
    setError(null);
    try {
      await api.login(code.trim());
      // App reloads the config and sends the user to ?next= once the session is visible.
      onSignedIn();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message.charAt(0).toUpperCase() + e.message.slice(1) + "." : "The server cannot be reached.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="center-page">
      <div className="login-card">
        <span className="brand">
          <Mark logoUrl={config.logoUrl} />
          <span>{config.assistantName}</span>
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="prompt">$ sign in</span>
          <h1>
            {config.companyName}'s knowledge, with sources<span className="caret">_</span>
          </h1>
        </div>
        {config.authMode === "google" ? (
          <a className="btn btn-dark" href="/api/auth/google" style={{ minHeight: 52 }}>
            Continue with Google
          </a>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <label htmlFor="code" style={{ fontWeight: 600, fontSize: 14 }}>
              Access code
            </label>
            <input
              id="code"
              className="field"
              type="password"
              autoComplete="current-password"
              placeholder="Given by your team"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              style={{ minHeight: 48, fontSize: 16 }}
              autoFocus
            />
            <button type="submit" className="btn btn-accent" disabled={pending || !code.trim()} style={{ minHeight: 48 }}>
              {pending ? "Checking..." : "Sign in"}
            </button>
          </form>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="fine">Internal tool. Answers come only from the company's Notion and always cite their page.</p>
      </div>
    </div>
  );
}
