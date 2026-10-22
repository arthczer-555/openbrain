import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  CatalogEntry,
  ModelsResponse,
  ModelTestResponse,
  PublicConfig,
  Report,
  ReportsResponse,
} from "@openbrain/server/protocol";
import { Mark } from "../components/Logo.tsx";
import { api, ApiFailure } from "../lib/api.ts";
import { Link, useRoute } from "../lib/router.tsx";
import { daysAgo, shortDate } from "../lib/time.ts";

// The admin (.design/Admin.dc.html), minimal on purpose: flagged questions and models.

function AdminHeader({ config, tab }: { config: PublicConfig; tab: "reports" | "models" }) {
  return (
    <header className="page-header">
      <div className="page-header-inner">
        <Link href="/" className="brand">
          <Mark logoUrl={config.logoUrl} />
          <span>{config.assistantName}</span>
          <span className="tag">admin</span>
        </Link>
        <nav className="tabs" aria-label="Admin sections">
          <Link href="/admin" className="tab" aria-current={tab === "reports" ? "page" : undefined}>
            Flagged questions
          </Link>
          <Link href="/admin/models" className="tab" aria-current={tab === "models" ? "page" : undefined}>
            Models
          </Link>
          <Link href="/" className="tab">
            Back to chat
          </Link>
        </nav>
      </div>
    </header>
  );
}

function AdminGate({ config, onSignedIn }: { config: PublicConfig; onSignedIn: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    try {
      await api.adminLogin(code.trim());
      onSignedIn();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "The server cannot be reached.");
    }
  };
  return (
    <div className="center-page">
      <div className="login-card">
        <span className="brand">
          <Mark logoUrl={config.logoUrl} />
          <span>{config.assistantName}</span>
          <span className="tag">admin</span>
        </span>
        <h1>
          Admin access<span className="caret">_</span>
        </h1>
        {config.authMode === "google" ? (
          <p className="fine">Your account is not an admin. An admin email must be listed in ADMIN_EMAILS on the server.</p>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <label htmlFor="admin-code" style={{ fontWeight: 600, fontSize: 14 }}>
              Admin code
            </label>
            <input id="admin-code" className="field" type="password" value={code} onChange={(e) => setCode(e.target.value)} style={{ minHeight: 48 }} autoFocus />
            <button type="submit" className="btn btn-dark" disabled={!code.trim()} style={{ minHeight: 48 }}>
              Open the admin
            </button>
          </form>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Link href="/" className="fine">
          Back to chat
        </Link>
      </div>
    </div>
  );
}

// ---------- Flagged questions ----------

type TypeFilter = "" | "no_answer" | "thumbs_down";
type StatusFilter = "open" | "done" | "";

function pagesCited(r: Report): string {
  const pages = [...new Set((r.citations ?? []).map((c) => c.page))];
  return pages.length > 0 ? pages.join(", ") : "none";
}

function Reports() {
  const [type, setType] = useState<TypeFilter>("");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [data, setData] = useState<ReportsResponse | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.reports({ type, status }).then(setData, (e: unknown) => setError(e instanceof ApiFailure ? e.message : "Could not load the reports."));
  }, [type, status]);
  useEffect(load, [load]);

  const mark = async (r: Report): Promise<void> => {
    await api.markReports([r.id], r.status === "open" ? "done" : "open");
    load();
  };

  const days = daysAgo(data?.lastWeeklyUpdate);
  return (
    <div className="page-body">
      <div className="page-title">
        <h1>Flagged questions</h1>
        <span className="sub">
          {days === null ? "No weekly update recorded yet." : `Last weekly update ${days === 0 ? "today" : `${days} day${days > 1 ? "s" : ""} ago`}.`} These are
          handled at the next one: <code>claude /weekly</code>
        </span>
      </div>
      {days !== null && days > 8 && (
        <div className="warning">
          <span>The weekly update is late: questions flagged since then are waiting. Run it from the instance repo.</span>
        </div>
      )}
      <div className="filters" role="group" aria-label="Filters">
        {(
          [
            ["", "All signals"],
            ["no_answer", "No answer"],
            ["thumbs_down", "Thumbs down"],
          ] as const
        ).map(([value, label]) => (
          <button key={label} type="button" className="chip" aria-pressed={type === value} onClick={() => setType(value)}>
            {label}
          </button>
        ))}
        <span style={{ width: 12 }} />
        {(
          [
            ["open", "To handle"],
            ["done", "Handled"],
            ["", "All"],
          ] as const
        ).map(([value, label]) => (
          <button key={label} type="button" className="chip" aria-pressed={status === value} onClick={() => setStatus(value)}>
            {label}
          </button>
        ))}
      </div>
      {error && <div className="empty">{error}</div>}
      {!data && !error && (
        <div className="loading" style={{ minHeight: 160 }}>
          <div className="spinner" />
        </div>
      )}
      {data && data.reports.length === 0 && <div className="empty">Nothing flagged here. Unanswered questions and thumbs down land in this list.</div>}
      {data && data.reports.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Signal</th>
                <th scope="col">Question</th>
                <th scope="col">Comment</th>
                <th scope="col">Pages cited</th>
                <th scope="col">Date</th>
              </tr>
            </thead>
            <tbody>
              {data.reports.map((r) => (
                <Fragment key={r.id}>
                  <tr className="clickable" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                    <td>
                      <span className={`signal ${r.type}`}>{r.type === "thumbs_down" ? "Thumbs down" : "No answer"}</span>
                    </td>
                    <td className="cell-question">{r.question}</td>
                    <td className={r.comment ? undefined : "cell-faint"}>{r.comment ?? "-"}</td>
                    <td className={`cell-mono${r.citations && r.citations.length > 0 ? "" : " cell-faint"}`}>{pagesCited(r)}</td>
                    <td className="cell-date">{shortDate(r.created_at)}</td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={5}>
                        <div className="detail">
                          {r.answer && (
                            <div>
                              <h3>Answer given</h3>
                              <div className="box">{r.answer}</div>
                            </div>
                          )}
                          <div>
                            <h3>Searches</h3>
                            <div className="box">
                              {(r.searches ?? []).map((s) => `"${s.query}"${s.section ? ` in ${s.section}` : ""}: ${s.results.slice(0, 3).map((x) => `${x.page} (${x.score})`).join(", ") || "nothing"}`).join("\n") ||
                                (r.searched ?? []).map((q) => `"${q}"`).join("\n") ||
                                "-"}
                              {r.top_results && r.top_results.length > 0 ? `\nbest pages: ${r.top_results.map((t) => `${t.page} (${t.score})`).join(", ")}` : ""}
                            </div>
                          </div>
                          <div>
                            <h3>Context</h3>
                            <div className="box">
                              {[
                                ...(r.context ?? []).map((c) => `before: ${c.text}`),
                                `model: ${r.model.provider}:${r.model.model} (${r.model.mode})`,
                                `version: ${r.deploy.commit ? r.deploy.commit.slice(0, 7) : "local"}`,
                                `user: ${r.user}`,
                              ].join("\n")}
                            </div>
                            <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => void mark(r)}>
                              {r.status === "open" ? "Mark handled" : "Reopen"}
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Models ----------

function priceLabel(m: CatalogEntry): string {
  if (m.provider === "demo") return "free";
  return m.price ? `$${m.price.input} / $${m.price.output}` : "not priced";
}

function Models() {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<"" | "low" | "medium" | "high">("");
  const [fallback, setFallback] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [test, setTest] = useState<ModelTestResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.models().then(
      (d) => {
        setData(d);
        setModel(d.roles.chat.model);
        setEffort(d.roles.chat.effort ?? "");
        setFallback(d.roles.chat.fallbacks[0] ?? "");
      },
      (e: unknown) => setError(e instanceof ApiFailure ? e.message : "Could not load the models."),
    );
  }, []);
  useEffect(load, [load]);

  const choices = useMemo(() => {
    const byProvider = new Map<string, CatalogEntry[]>();
    for (const m of data?.models ?? []) {
      if (!m.available && m.id !== model) continue;
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    return [...byProvider.entries()];
  }, [data, model]);

  const flash = (text: string): void => {
    setToast(text);
    setTimeout(() => setToast(null), 2200);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.updateModels({ chat: { model, effort: effort || null, fallbacks: fallback && fallback !== model ? [fallback] : [] } });
      flash("Saved: the chat uses this model now, no redeploy needed.");
      load();
    } catch (e) {
      flash(e instanceof ApiFailure ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const reset = async (): Promise<void> => {
    await api.updateModels({ chat: null });
    flash("Back to the model of openbrain.config.yaml.");
    load();
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.testModel(model));
    } catch (e) {
      flash(e instanceof ApiFailure ? e.message : "The test failed.");
    } finally {
      setTesting(false);
    }
  };

  const saveUserChoice = async (enabled: boolean, allowed: string[]): Promise<void> => {
    await api.updateModels({ userChoice: { enabled, allowed } });
    load();
  };

  if (error) return <div className="page-body"><div className="empty">{error}</div></div>;
  if (!data) {
    return (
      <div className="page-body">
        <div className="loading" style={{ minHeight: 200 }}>
          <div className="spinner" />
        </div>
      </div>
    );
  }
  const current = data.models.find((m) => m.id === data.roles.chat.model);
  const configured = data.providers.filter((p) => p.configured && p.id !== "demo");

  return (
    <div className="page-body">
      <div className="page-title">
        <h1>Models</h1>
        <span className="sub">Any provider, any model. A change applies to the next question, without redeploying.</span>
      </div>
      <div className="grid-2">
        <section className="card" aria-labelledby="chat-model">
          <h2 id="chat-model">Chat model</h2>
          <p className="hint">
            Now: <b>{current?.name ?? data.roles.chat.model}</b> <span className="cell-mono">{data.roles.chat.model}</span>
            {data.roles.chat.effort ? `, effort ${data.roles.chat.effort}` : ""}.{" "}
            {data.roles.chat.source === "settings"
              ? "Changed from this page."
              : data.roles.chat.source === "cli"
                ? "Forced by the command line (openbrain demo or --model): changes here apply once it stops forcing it."
                : "From openbrain.config.yaml."}
            {data.roles.chat.fallbacks.length > 0 ? ` Fallback: ${data.roles.chat.fallbacks.join(", ")}.` : ""}
          </p>
          <div className="form-row">
            <label htmlFor="model">Model</label>
            <select id="model" className="field" value={model} onChange={(e) => setModel(e.target.value)}>
              {choices.map(([provider, list]) => (
                <optgroup key={provider} label={provider}>
                  {list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({priceLabel(m)}){m.tools ? "" : ", no tools"}
                      {m.verified ? "" : ", not verified"}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="effort">Effort</label>
            <select id="effort" className="field" value={effort} onChange={(e) => setEffort(e.target.value as typeof effort)}>
              <option value="">model default</option>
              <option value="low">low (fast, cheaper)</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
            <label htmlFor="fallback">Fallback</label>
            <select id="fallback" className="field" value={fallback} onChange={(e) => setFallback(e.target.value)}>
              <option value="">none</option>
              {choices.flatMap(([, list]) => list.filter((m) => m.id !== model && m.provider !== "demo")).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <button type="button" className="btn btn-accent" disabled={saving} onClick={() => void save()}>
              Use this model
            </button>
            <button type="button" className="btn" disabled={testing} onClick={() => void runTest()}>
              {testing ? "Testing on 5 questions..." : "Test on 5 questions"}
            </button>
            {data.roles.chat.source === "settings" && (
              <button type="button" className="btn btn-sm" onClick={() => void reset()}>
                Back to the config
              </button>
            )}
          </div>
          <p className="hint" style={{ fontSize: 13 }}>
            Prices in USD per million tokens (input / output). Slow reasoning models may hit the 60 s limit of Netlify: test first.
          </p>
        </section>

        <section className="card" aria-labelledby="providers">
          <h2 id="providers">Providers</h2>
          <p className="hint">A provider appears once its key is set in the Netlify environment. Keys are never shown here.</p>
          <div className="providers">
            {data.providers
              .filter((p) => p.id !== "demo")
              .map((p) => (
                <div className="provider" key={p.id}>
                  <span>
                    <span className={`dot${p.configured && !p.local ? " on" : ""}`} />
                    {p.label}
                    {p.local ? <span className="cell-faint"> (local only)</span> : null}
                  </span>
                  <span className="cell-mono">
                    {p.local ? "CLI only" : p.configured ? (p.error ? `error: ${p.error}` : "connected") : (p.envKeys[0] ?? "base_url")}
                  </span>
                </div>
              ))}
          </div>
          {configured.length === 0 && <p className="hint">No provider key yet: the demo model answers by quoting passages.</p>}
        </section>
      </div>

      {test && (
        <section className="card" aria-labelledby="test">
          <h2 id="test">Test of {test.model}</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Question</th>
                  <th scope="col">Result</th>
                  <th scope="col">Sources</th>
                  <th scope="col">Tokens in / out</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Time</th>
                </tr>
              </thead>
              <tbody>
                {test.results.map((r) => (
                  <tr key={r.question}>
                    <td className="cell-question">
                      {r.question}
                      <div className="cell-faint" style={{ fontWeight: 400, marginTop: 4 }}>
                        {r.error ?? r.answerPreview}
                      </div>
                    </td>
                    <td>{r.error ? "error" : r.flagged ? "flagged" : r.ok ? "answered" : "cut"}</td>
                    <td className="cell-mono">{r.citations}</td>
                    <td className="cell-mono">
                      {r.inputTokens} / {r.outputTokens}
                    </td>
                    <td className="cell-mono">{r.costUsd === null ? "n/a" : `$${r.costUsd.toFixed(4)}`}</td>
                    <td className="cell-mono">{(r.latencyMs / 1000).toFixed(1)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="choice">
        <h2 id="choice">Let people pick a model</h2>
        <p className="hint">Off by default. When on, the chat shows a model menu with the models allowed here.</p>
        <label className="form-row" style={{ fontSize: 14 }}>
          <input type="checkbox" checked={data.userChoice.enabled} onChange={(e) => void saveUserChoice(e.target.checked, data.userChoice.allowed)} />
          Show the model menu in the chat
        </label>
        {data.userChoice.enabled && (
          <div className="providers">
            {data.models
              .filter((m) => m.available && m.provider !== "demo")
              .map((m) => {
                const allowed = data.userChoice.allowed.includes(m.id);
                return (
                  <label key={m.id} className="provider" style={{ justifyContent: "flex-start", gap: 10 }}>
                    <input
                      type="checkbox"
                      checked={allowed}
                      onChange={() =>
                        void saveUserChoice(true, allowed ? data.userChoice.allowed.filter((id) => id !== m.id) : [...data.userChoice.allowed, m.id])
                      }
                    />
                    {m.name} <span className="cell-mono">{priceLabel(m)}</span>
                  </label>
                );
              })}
          </div>
        )}
      </section>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

export function Admin({ config, onSignedIn }: { config: PublicConfig; onSignedIn: () => void }) {
  const route = useRoute();
  const tab = route.path === "/admin/models" ? "models" : "reports";
  if (!config.user?.isAdmin) return <AdminGate config={config} onSignedIn={onSignedIn} />;
  return (
    <div className="page">
      <AdminHeader config={config} tab={tab} />
      {tab === "models" ? <Models /> : <Reports />}
    </div>
  );
}
