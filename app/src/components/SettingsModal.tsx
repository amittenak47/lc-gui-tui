/**
 * Settings modal — edits the shared `config.toml` via `lc serve`.
 * Backdrop blurs the board the same way problem-load transitions do.
 */

import { useCallback, useEffect, useState } from "react";

import type { LcClient } from "../api/client";
import type { DatasetInfo, LcConfig, LlmStatus, ProviderConfig } from "../api/types";

type TabId = "paths" | "datasets" | "tests" | "llm" | "serve";

const TABS: { id: TabId; label: string }[] = [
  { id: "paths", label: "Paths" },
  { id: "datasets", label: "Datasets" },
  { id: "tests", label: "Tests" },
  { id: "llm", label: "LLM" },
  { id: "serve", label: "Serve" },
];

const PROVIDERS = ["local", "ollama", "openai", "groq"] as const;
const MODES = ["ambient", "review", "bridge", "viz"] as const;

function emptyProvider(): ProviderConfig {
  return { base_url: "", model: "", vision_model: "" };
}

function emptyConfig(): LcConfig {
  return {
    data_json_dir: null,
    dataset_dirs: {},
    workspace_dir: "~/lc-workspace",
    python_executable: "python",
    stop_on_first_failure: false,
    default_provider: "local",
    local: emptyProvider(),
    ollama: emptyProvider(),
    openai: emptyProvider(),
    groq: emptyProvider(),
    modes: { ambient: "local", review: "local", bridge: "local", viz: "local" },
    serve_port: 7878,
    token_set: false,
  };
}

export interface SettingsModalProps {
  open: boolean;
  client: LcClient;
  onClose: () => void;
  onSaved?: () => void;
}

export function SettingsModal({ open, client, onClose, onSaved }: SettingsModalProps) {
  const [tab, setTab] = useState<TabId>("paths");
  const [draft, setDraft] = useState<LcConfig>(emptyConfig);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerFocus, setProviderFocus] = useState<"local" | "ollama" | "openai">("local");
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  /** Host / port / six-digit code to type on a tablet — null until loaded. */
  const [pairInfo, setPairInfo] = useState<{
    code: string | null;
    host: string | null;
    port: number;
  } | null>(null);

  const refreshLlm = useCallback(async () => {
    try {
      setLlmStatus(await client.llmStatus());
    } catch {
      setLlmStatus(null);
    }
  }, [client]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setBusy("loading…");
    void (async () => {
      try {
        const cfg = await client.getConfig();
        if (!cancelled) {
          setDraft(cfg);
          setBusy(null);
        }
        await refreshLlm();
        try {
          const all = await client.datasets();
          if (!cancelled) setDatasets(all);
        } catch {
          // An older daemon has no /datasets — the tab just says so.
          if (!cancelled) setDatasets([]);
        }
        try {
          const pair = await client.pairCode();
          if (!cancelled) setPairInfo(pair);
        } catch {
          // An older daemon has no /pair/code — the Serve tab just says so.
          if (!cancelled) setPairInfo(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setBusy(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, client, refreshLlm]);

  if (!open) return null;

  const patchProvider = (key: "local" | "ollama" | "openai" | "groq", patch: Partial<ProviderConfig>) => {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const save = async () => {
    setBusy("saving…");
    setError(null);
    try {
      const saved = await client.putConfig(draft);
      setDraft(saved);
      onSaved?.();
      setBusy(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const startLlm = async () => {
    setBusy("starting local LLM…");
    setError(null);
    try {
      setLlmStatus(await client.llmStart());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const stopLlm = async () => {
    setBusy("stopping local LLM…");
    setError(null);
    try {
      setLlmStatus(await client.llmStop());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const provider = draft[providerFocus];

  return (
    <div
      className="lc-settings-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="lc-settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="lc-settings-head">
          <h2>Settings</h2>
          <p className="lc-muted">Synced with TUI via config.toml</p>
        </div>

        <div className="lc-settings-tabs" role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? "lc-settings-tab is-active" : "lc-settings-tab"}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="lc-settings-body">
          {error && <div className="lc-warning">{error}</div>}
          {busy && <div className="lc-muted">{busy}</div>}

          {tab === "paths" && (
            <div className="lc-settings-fields">
              <label>
                <span>Problems folder</span>
                <input
                  value={draft.data_json_dir ?? ""}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      data_json_dir: e.target.value.trim() ? e.target.value : null,
                    }))
                  }
                  placeholder="path to JSON corpus"
                />
                <p className="lc-settings-hint">
                  Folder of problem JSON files — the same corpus the TUI indexes.
                </p>
              </label>
              <label>
                <span>Workspace dir</span>
                <input
                  value={draft.workspace_dir}
                  onChange={(e) => setDraft((prev) => ({ ...prev, workspace_dir: e.target.value }))}
                />
                <p className="lc-settings-hint">
                  Where generated solve folders go (~/lc-workspace/&lt;task&gt;).
                </p>
              </label>
              <label>
                <span>Python executable</span>
                <input
                  value={draft.python_executable}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, python_executable: e.target.value }))
                  }
                />
                <p className="lc-settings-hint">Python used to run tests.</p>
              </label>
            </div>
          )}

          {tab === "datasets" && (
            <div className="lc-settings-fields">
              <p className="lc-muted">
                Each problem set is indexed into its own table. By default a corpus lives in{" "}
                <code>&lt;problems folder&gt;/&lt;dataset&gt;/</code>; override it below when it
                lives somewhere else.
              </p>
              {datasets.length === 0 && (
                <p className="lc-muted">
                  This daemon does not report datasets — update <code>lc serve</code>.
                </p>
              )}
              {datasets.map((entry) => (
                <label key={entry.id}>
                  <span>
                    {entry.label}
                    <span className="lc-settings-badge">
                      {entry.count.toLocaleString()} indexed
                    </span>
                  </span>
                  <input
                    value={draft.dataset_dirs[entry.id] ?? ""}
                    placeholder={entry.corpus_dir ?? `<problems folder>/${entry.id}`}
                    onChange={(e) =>
                      setDraft((prev) => {
                        const dirs = { ...prev.dataset_dirs };
                        if (e.target.value.trim()) dirs[entry.id] = e.target.value;
                        else delete dirs[entry.id];
                        return { ...prev, dataset_dirs: dirs };
                      })
                    }
                  />
                  <p className="lc-settings-hint">
                    <code>{entry.source}</code> — index with{" "}
                    <code>lc index --dataset {entry.id}</code>
                  </p>
                </label>
              ))}
            </div>
          )}

          {tab === "tests" && (
            <div className="lc-settings-fields">
              <div className="lc-settings-subhead">When a case fails</div>
              <div className="lc-settings-choice" role="radiogroup" aria-label="Test run mode">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!draft.stop_on_first_failure}
                  className={
                    draft.stop_on_first_failure
                      ? "lc-settings-choice-option"
                      : "lc-settings-choice-option is-active"
                  }
                  onClick={() =>
                    setDraft((prev) => ({ ...prev, stop_on_first_failure: false }))
                  }
                >
                  <strong>Run every case</strong>
                  <span className="lc-muted">
                    Keep going after a failure and report the whole picture — “3/12 passed”.
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.stop_on_first_failure}
                  className={
                    draft.stop_on_first_failure
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setDraft((prev) => ({ ...prev, stop_on_first_failure: true }))}
                >
                  <strong>Stop at the first failure</strong>
                  <span className="lc-muted">
                    Quit as soon as a case fails. Faster on problems with hundreds of cases.
                  </span>
                </button>
              </div>
              <p className="lc-settings-hint">
                Applies to <strong>Run tests</strong>, <strong>Submit</strong>, and{" "}
                <code>lc test</code>. Running every case is what lets the coach pick a real
                counterexample, so leave it on unless a run is slow.
              </p>
            </div>
          )}

          {tab === "llm" && (
            <div className="lc-settings-fields">
              <label>
                <span>Default provider</span>
                <select
                  value={draft.default_provider}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, default_provider: e.target.value }))
                  }
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>

              <div className="lc-settings-provider-tabs" role="tablist">
                {(["local", "ollama", "openai"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="tab"
                    aria-selected={providerFocus === p}
                    className={
                      providerFocus === p
                        ? "lc-settings-subtab is-active"
                        : "lc-settings-subtab"
                    }
                    onClick={() => setProviderFocus(p)}
                  >
                    {p === "local" ? "Local" : p === "ollama" ? "Ollama" : "OpenAI"}
                  </button>
                ))}
              </div>

              <label>
                <span>Base URL</span>
                <input
                  value={provider.base_url}
                  onChange={(e) => patchProvider(providerFocus, { base_url: e.target.value })}
                />
              </label>
              <label>
                <span>Chat model</span>
                <input
                  value={provider.model}
                  onChange={(e) => patchProvider(providerFocus, { model: e.target.value })}
                />
              </label>
              <label>
                <span>Vision model</span>
                <input
                  value={provider.vision_model}
                  onChange={(e) =>
                    patchProvider(providerFocus, { vision_model: e.target.value })
                  }
                  placeholder="(same as chat model)"
                />
                <p className="lc-settings-hint">
                  Separate vision model for PNG board captures. Leave empty to reuse the chat model.
                </p>
              </label>

              {providerFocus === "openai" && (
                <p className="lc-muted">API key from OPENAI_API_KEY env — not stored in config.toml.</p>
              )}

              <div className="lc-settings-subhead">Coach mode providers</div>
              {MODES.map((mode) => (
                <label key={mode}>
                  <span>{mode}</span>
                  <select
                    value={draft.modes[mode]}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        modes: { ...prev.modes, [mode]: e.target.value },
                      }))
                    }
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
              ))}

              <div className="lc-settings-subhead">Local process</div>
              <p className="lc-muted">
                {llmStatus?.detail ?? "Status unknown"}
                {llmStatus?.pid != null ? ` · pid ${llmStatus.pid}` : ""}
              </p>
              <div className="lc-settings-actions-row">
                <button type="button" className="lc-secondary" disabled={!!busy} onClick={() => void startLlm()}>
                  Start local LLM
                </button>
                <button type="button" className="lc-secondary" disabled={!!busy} onClick={() => void stopLlm()}>
                  Stop local LLM
                </button>
                <button type="button" className="lc-secondary" disabled={!!busy} onClick={() => void refreshLlm()}>
                  Refresh
                </button>
              </div>
            </div>
          )}

          {tab === "serve" && (
            <div className="lc-settings-fields">
              <label>
                <span>Port</span>
                <input
                  type="number"
                  value={draft.serve_port}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      serve_port: Number(e.target.value) || prev.serve_port,
                    }))
                  }
                />
              </label>
              <p className="lc-muted">
                Pairing token: {draft.token_set ? "set (use lc serve --lan to rotate)" : "not set (loopback only)"}
              </p>

              <div className="lc-settings-subhead">Pair a tablet</div>
              {pairInfo?.code ? (
                <>
                  <dl className="lc-pair-readout">
                    <div>
                      <dt>Host</dt>
                      <dd>{pairInfo.host ?? "this machine's LAN address"}</dd>
                    </div>
                    <div>
                      <dt>Port</dt>
                      <dd>{pairInfo.port}</dd>
                    </div>
                    <div>
                      <dt>Code</dt>
                      <dd className="lc-pair-code">{pairInfo.code}</dd>
                    </div>
                  </dl>
                  <p className="lc-muted">
                    Type these three into the tablet's header. The code changes every time
                    `lc serve --lan` restarts; devices already paired keep working.
                  </p>
                </>
              ) : (
                <p className="lc-muted">
                  No pairing code — this daemon is loopback-only. Restart it with
                  {" "}
                  <code>lc serve --lan</code> to pair a tablet.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="lc-settings-foot">
          <button type="button" className="lc-secondary" disabled={!!busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="lc-primary" disabled={!!busy} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
