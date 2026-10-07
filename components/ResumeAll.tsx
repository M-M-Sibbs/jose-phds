"use client";

import { useState, useEffect } from "react";

type Resumable = {
  id: string;
  title: string;
  status: string;
  chaptersSoFar: number;
};

/**
 * Resume-all panel.
 *
 * On mount it asks /api/resume which of the user's projects are stalled
 * (mid-generation or failed). For each, pressing Resume re-opens it and the
 * provided onResume callback drives /api/generate from the saved step — the
 * same path the inline Resume button uses.
 *
 * This is the manual trigger today; the identical /api/resume endpoint can be
 * called by a Vercel Cron job once the client is on a plan that includes it,
 * so stalled projects continue automatically after the daily quota resets.
 */
export function ResumeAll({
  onResume,
}: {
  onResume: (projectId: string, step: unknown) => void;
}) {
  const [items, setItems] = useState<Resumable[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/resume", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          setItems(data.resumable ?? []);
        }
      } catch {
        /* nothing to show */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function resume(projectId: string) {
    const res = await fetch("/api/resume", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    if (res.ok) {
      const data = await res.json();
      setItems((prev) => prev.filter((i) => i.id !== projectId));
      onResume(projectId, data.resumeStep);
    }
  }

  if (loading || items.length === 0) return null;

  return (
    <section
      className="mb-10 rounded border p-4"
      style={{ borderColor: "var(--rule)" }}
    >
      <h2 className="mono mb-3" style={{ color: "var(--ink-soft)" }}>
        Unfinished — ready to continue
      </h2>
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.id} className="flex items-center justify-between text-sm">
            <span>
              {i.title}{" "}
              <span className="mono" style={{ color: "var(--ink-soft)" }}>
                · {i.chaptersSoFar} chapter{i.chaptersSoFar === 1 ? "" : "s"} so far
              </span>
            </span>
            <button
              onClick={() => resume(i.id)}
              className="display rounded px-4 py-1 text-xs text-white"
              style={{ background: "var(--iron)" }}
            >
              Resume
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
