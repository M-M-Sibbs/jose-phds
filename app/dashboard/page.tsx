"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { UploadPanel } from "@/components/UploadPanel";
import { MIN_KNOWLEDGE_DOCS } from "@/lib/config/limits";

type Project = {
  id: string;
  title: string;
  topic: string;
  objectives: string;
  questions: string;
  styleProfile: { citationStyle: string } | null;
  structureSpec: { chapters: { title: string }[] } | null;
  _count?: { documents: number };
};

type Step = Record<string, unknown> | null;

type StepResponse = {
  label: string;
  warning?: string | null;
  next: Step;
  progress: number;
  error?: string;
  retryStep?: Step;
};

/**
 * Turns an already-read response body into a readable message.
 *
 * Takes text rather than the Response itself: a body can only be read once, so
 * a helper that calls res.text() internally will throw "body stream already
 * read" whenever the caller has also parsed the response.
 */
function formatError(body: string, status: number): string {
  try {
    const p = JSON.parse(body);
    if (p?.error) return p.error;
    if (p?.message) return p.message;
  } catch { /* not JSON */ }

  if (body.trimStart().startsWith("<")) {
    const m = body.match(/"message":"([^"]{5,300})"/);
    if (m) return m[1].replace(/\\u003e/g, ">").replace(/\\"/g, '"');
    return `Server error (${status}). Check the terminal running npm run dev.`;
  }
  return body.slice(0, 300) || `Request failed (${status}).`;
}

/** Reads the body once and formats it. Only safe when nothing else reads it. */
async function readError(res: Response): Promise<string> {
  try {
    return formatError(await res.text(), res.status);
  } catch {
    return `Request failed (${res.status}).`;
  }
}

export default function Dashboard() {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [knowledgeCount, setKnowledgeCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [resumeStep, setResumeStep] = useState<Step>(null);
  const [chapters, setChapters] = useState<{ title: string; body: string }[]>([]);
  const cancelled = useRef(false);

  const [form, setForm] = useState({ title: "", topic: "", objectives: "", questions: "" });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      const raw = await res.text();
      if (!res.ok) { setError(formatError(raw, res.status)); return; }

      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        setError(formatError(raw, res.status));
        return;
      }

      const first = data.projects?.[0] ?? null;
      setProject(first);
      setKnowledgeCount(first?._count?.documents ?? 0);
    } catch {
      setError("Could not reach the server. Is npm run dev still running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Chapters persist after every step, so show whatever exists - a run halted
  // by a daily quota still leaves usable drafts behind.
  useEffect(() => {
    if (project) loadChapters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  async function createProject() {
    setError(null);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const raw = await res.text();
    if (!res.ok) { setError(formatError(raw, res.status)); return; }

    let created: any;
    try {
      created = JSON.parse(raw);
    } catch {
      setError("The server response could not be read.");
      return;
    }
    const { project } = created;
    setProject({ ...project, _count: { documents: 0 } });
  }

  /**
   * Drives the pipeline one step per request. Each call returns the next step,
   * so no single request runs long enough to hit a serverless timeout, and a
   * failure can be retried from exactly where it stopped.
   */
  async function runPipeline(from: Step = null) {
    if (!project) return;
    cancelled.current = false;
    setRunning(true);
    setError(null);
    if (!from) { setWarnings([]); setLog([]); setProgress(0); }

    let step: Step = from;
    let guard = 0;

    while (guard++ < 80) {
      if (cancelled.current) { setLog((l) => [...l, "Paused."]); break; }

      let res: Response;
      try {
      res = await fetch("/api/generate", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: project.id, step }),
        });
      } catch {
        setError("Lost connection to the server. Press Resume to continue.");
        setResumeStep(step);
        break;
      }

      // Read the body exactly once, then decide how to interpret it.
      const raw = await res.text();
      let data: StepResponse;
      try {
        data = JSON.parse(raw);
      } catch {
        setError(formatError(raw, res.status));
        setResumeStep(step);
        break;
      }

      if (!res.ok || data.error) {
        setError(data.error ?? `Step failed (${res.status}).`);
        setResumeStep(data.retryStep ?? step);
        break;
      }

      setLog((l) => [...l, data.label]);
      if (data.warning) setWarnings((w) => [...w, data.warning!]);
      setProgress(Math.min(1, data.progress ?? 0));
      setResumeStep(null);

      if (!data.next) { await loadChapters(); break; }
      step = data.next;
    }

    setRunning(false);
  }

  async function loadChapters() {
    if (!project) return;
    try {
      const res = await fetch(`/api/projects/chapters?projectId=${project.id}`);
      if (!res.ok) return;
      const data = JSON.parse(await res.text());
      setChapters((data.chapters ?? []).filter((c: any) => c.body?.trim()));
    } catch {
      /* leave existing chapters in place */
    }
  }

  async function exportAs(format: "markdown" | "docx") {
    if (!project) return;
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, format }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      // Stream the response straight to a download.
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${format === "markdown" ? "md" : "docx"}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Export failed.");
    }
  }

  const hasSample = Boolean(project?.styleProfile);
  const enoughDocs = knowledgeCount >= MIN_KNOWLEDGE_DOCS;
  const canGenerate = hasSample && enoughDocs && !running;

  if (loading) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-24">
        <p className="mono" style={{ color: "var(--ink-soft)" }}>Loading...</p>
      </main>
    );
  }

  // [key, label, placeholder, multiline, minimum characters]
  const fields: [string, string, string, boolean, number][] = [
    ["title", "Project title", "Smart agriculture framework", false, 3],
    ["topic", "Research topic", "Develop an AI framework for smart agriculture in smallholder farming systems", true, 10],
    ["objectives", "Objectives", "1. Review existing AI applications in precision agriculture\n2. Identify barriers to smallholder adoption", true, 10],
    ["questions", "Research questions", "What factors determine AI adoption among smallholder farmers?", true, 10],
  ];

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-12 border-b pb-8" style={{ borderColor: "var(--rule)" }}>
        <p className="mono mb-3" style={{ color: "var(--ink-soft)" }}>Jose PhD&rsquo;s</p>
        <h1 className="display text-4xl leading-tight">
          Draft the thesis your evidence can actually support.
        </h1>
      </header>

      {error && (
        <div className="mb-8 border-l-2 py-2 pl-4" style={{ borderColor: "var(--pencil)" }}>
          <p className="mono mb-1" style={{ color: "var(--pencil)" }}>Error</p>
          <p className="text-sm">{error}</p>
          {resumeStep && !running && (
            <button
              onClick={() => runPipeline(resumeStep)}
              className="display mt-3 rounded px-4 py-2 text-xs text-white"
              style={{ background: "var(--iron)" }}
            >
              Resume from here
            </button>
          )}
        </div>
      )}

      {!project ? (
        <section>
          <h2 className="display mb-2 text-2xl">Start a project</h2>
          <p className="mb-6 text-sm" style={{ color: "var(--ink-soft)" }}>
            Describe the research first. The critical pass checks every chapter
            against these objectives.
          </p>
          <div className="space-y-5">
            {fields.map(([key, label, placeholder, multiline, min]) => {
              const value = (form as any)[key] as string;
              const short = value.trim().length < min;
              return (
              <label key={key} className="block">
                <span className="mono mb-2 flex justify-between" style={{ color: "var(--ink-soft)" }}>
                  <span>{label}</span>
                  <span style={{ color: short ? "var(--pencil)" : "var(--ink-soft)" }}>
                    {value.trim().length}/{min}
                  </span>
                </span>
                {multiline ? (
                  <textarea
                    rows={3}
                    value={(form as any)[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    placeholder={placeholder}
                    className="w-full rounded border bg-transparent px-3 py-2 text-sm"
                    style={{ borderColor: short && value.length ? "var(--pencil)" : "var(--rule)", color: "var(--ink)" }}
                  />
                ) : (
                  <input
                    value={(form as any)[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    placeholder={placeholder}
                    className="w-full rounded border bg-transparent px-3 py-2 text-sm"
                    style={{ borderColor: short && value.length ? "var(--pencil)" : "var(--rule)", color: "var(--ink)" }}
                  />
                )}
              </label>
              );
            })}
          </div>
          <button
            onClick={createProject}
            disabled={fields.some(([k, , , , min]) => ((form as any)[k] as string).trim().length < min)}
            className="display mt-7 rounded px-6 py-3 text-sm text-white disabled:opacity-40"
            style={{ background: "var(--iron)" }}
          >
            Create project
          </button>
        </section>
      ) : (
        <>
          <section className="mb-10">
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="display text-2xl">1. Sample thesis</h2>
              <span className="mono" style={{ color: hasSample ? "var(--iron)" : "var(--ink-soft)" }}>
                {hasSample ? `${project.styleProfile!.citationStyle} learned` : "Required"}
              </span>
            </div>
            <UploadPanel projectId={project.id} kind="sample" onDone={() => load()} />
          </section>

          <section className="mb-10">
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="display text-2xl">2. Structure guidance</h2>
              <span className="mono" style={{ color: project.structureSpec ? "var(--iron)" : "var(--ink-soft)" }}>
                {project.structureSpec?.chapters?.length
                  ? `${project.structureSpec.chapters.length} chapters required`
                  : "Optional"}
              </span>
            </div>
            <p className="mb-4 text-sm" style={{ color: "var(--ink-soft)" }}>
              Supervisor notes, a department handbook, or a proposal template.
              Where this conflicts with the sample thesis, these requirements win.
            </p>
            <UploadPanel projectId={project.id} kind="structure" onDone={() => load()} />
          </section>

          <section className="mb-10">
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="display text-2xl">3. Knowledge documents</h2>
              <span className="mono" style={{ color: enoughDocs ? "var(--iron)" : "var(--ink-soft)" }}>
                {knowledgeCount} of {MIN_KNOWLEDGE_DOCS} minimum
              </span>
            </div>
            <UploadPanel projectId={project.id} kind="knowledge" onDone={(c) => setKnowledgeCount(c)} />
          </section>

          <section className="mb-10">
            <h2 className="display mb-4 text-2xl">4. Generate</h2>

            <div className="flex items-center gap-3">
              <button
                onClick={() => runPipeline(null)}
                disabled={!canGenerate}
                className="display rounded px-6 py-3 text-sm text-white disabled:opacity-40"
                style={{ background: "var(--iron)" }}
              >
                {running ? "Generating..." : "Generate thesis"}
              </button>
              {running && (
                <button
                  onClick={() => { cancelled.current = true; }}
                  className="display rounded border px-4 py-3 text-sm"
                  style={{ borderColor: "var(--rule)", color: "var(--ink-soft)" }}
                >
                  Pause
                </button>
              )}
            </div>

            {!canGenerate && !running && (
              <p className="mt-3 text-sm" style={{ color: "var(--ink-soft)" }}>
                {!hasSample
                  ? "Upload a sample thesis first - the house style is read from it."
                  : `Add ${MIN_KNOWLEDGE_DOCS - knowledgeCount} more knowledge document${MIN_KNOWLEDGE_DOCS - knowledgeCount === 1 ? "" : "s"}.`}
              </p>
            )}

            {(running || progress > 0) && (
              <div className="mt-6">
                <div className="h-px w-full" style={{ background: "var(--rule)" }}>
                  <div
                    className="h-px transition-all duration-500"
                    style={{ width: `${progress * 100}%`, background: "var(--iron)" }}
                  />
                </div>
                <ul className="mt-4 space-y-1">
                  {log.slice(-8).map((l, i) => (
                    <li key={i} className="mono" style={{ color: "var(--ink-soft)" }}>{l}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </>
      )}

      {warnings.length > 0 && (
        <section className="mb-10">
          <h2 className="mono mb-3" style={{ color: "var(--pencil)" }}>Verify before submission</h2>
          <ul className="space-y-2">
            {warnings.map((w, i) => (
              <li key={i} className="border-l-2 pl-4 text-sm" style={{ borderColor: "var(--pencil)" }}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      {chapters.length > 0 && (
        <div>
          <div className="mb-8 flex items-center gap-3 border-t pt-6" style={{ borderColor: "var(--rule)" }}>
            <span className="mono" style={{ color: "var(--ink-soft)" }}>
              {chapters.length} chapter{chapters.length === 1 ? "" : "s"} drafted
            </span>
            <span className="flex-1" />
            <button
              onClick={() => exportAs("markdown")}
              className="display rounded border px-4 py-2 text-xs"
              style={{ borderColor: "var(--rule)", color: "var(--ink)" }}
            >
              Export .md
            </button>
            <button
              onClick={() => exportAs("docx")}
              className="display rounded px-4 py-2 text-xs text-white"
              style={{ background: "var(--iron)" }}
            >
              Export .docx
            </button>
          </div>
          {chapters.map((c) => (
            <article key={c.title} className="mb-10">
              <h2 className="display mb-3 text-2xl">{c.title}</h2>
              <div className="whitespace-pre-wrap leading-relaxed">{c.body}</div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
