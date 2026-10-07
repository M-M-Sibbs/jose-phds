"use client";

import { useState } from "react";

/**
 * Revision chat panel.
 *
 * Self-contained: drop it in and mount once per generated chapter, passing the
 * projectId and that chapter's order. The user types an instruction, it calls
 * /api/revise for that one chapter, and on success hands the new body back via
 * onRevised so the parent can update what it shows.
 */
export function ReviseChat({
  projectId,
  chapterOrder,
  chapterTitle,
  onRevised,
}: {
  projectId: string;
  chapterOrder: number;
  chapterTitle: string;
  onRevised?: (body: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit() {
    const text = instruction.trim();
    if (text.length < 3) return;
    setBusy(true);
    setError(null);
    setDone(null);

    try {
      const res = await fetch("/api/revise", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, chapterOrder, instruction: text }),
      });

      const raw = await res.text();
      let data: any = null;
      try {
        data = JSON.parse(raw);
      } catch {
        /* fall through to generic message */
      }

      if (!res.ok) {
        setError(data?.error ?? `Revision failed (${res.status}).`);
        return;
      }

      onRevised?.(data.body);
      setDone("Chapter updated.");
      setInstruction("");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mono mt-2 rounded border px-3 py-1 text-xs"
        style={{ borderColor: "var(--rule)", color: "var(--ink-soft)" }}
      >
        Revise this chapter
      </button>
    );
  }

  return (
    <div
      className="mt-3 rounded border p-3"
      style={{ borderColor: "var(--rule)" }}
    >
      <p className="mono mb-2" style={{ color: "var(--ink-soft)" }}>
        Revise: {chapterTitle}
      </p>
      <textarea
        rows={2}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="e.g. make this more critical of GM crops, or shorten the methodology"
        className="w-full rounded border bg-transparent px-3 py-2 text-sm"
        style={{ borderColor: "var(--rule)", color: "var(--ink)" }}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy || instruction.trim().length < 3}
          className="display rounded px-4 py-2 text-xs text-white disabled:opacity-40"
          style={{ background: "var(--iron)" }}
        >
          {busy ? "Revising…" : "Apply"}
        </button>
        <button
          onClick={() => {
            setOpen(false);
            setError(null);
            setDone(null);
          }}
          className="display rounded border px-4 py-2 text-xs"
          style={{ borderColor: "var(--rule)", color: "var(--ink-soft)" }}
        >
          Close
        </button>
        {done && (
          <span className="mono" style={{ color: "var(--iron)" }}>
            {done}
          </span>
        )}
      </div>
      {error && (
        <p
          className="mono mt-2 border-l-2 pl-2"
          style={{ borderColor: "var(--pencil)", color: "var(--pencil)" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
