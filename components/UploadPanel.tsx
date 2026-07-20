"use client";

import { useState, useCallback } from "react";
import { MIN_KNOWLEDGE_DOCS } from "@/lib/config/limits";

type UploadResult = {
  filename: string;
  chunks?: number;
  error?: string;
  styleProfile?: { citationStyle: string; chapterSequence: string[] };
  structureSpec?: { chapters: { title: string }[]; mandatoryElements: string[] };
};

export function UploadPanel({
  projectId,
  kind,
  onDone,
}: {
  projectId: string;
  kind: "sample" | "structure" | "knowledge";
  onDone?: (count: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      setBusy(true);
      setError(null);

      const form = new FormData();
      form.set("projectId", projectId);
      form.set("kind", kind);
      Array.from(files).forEach((f) => form.append("files", f));

      try {
        const res = await fetch("/api/upload", { method: "POST", body: form });

        // The route may return JSON, plain text, or an HTML error page.
        // Surface whatever it actually said rather than a guess about the cause.
        const raw = await res.text();
        let data: any = null;
        try {
          data = JSON.parse(raw);
        } catch {
          /* not JSON */
        }

        if (!res.ok) {
          if (data?.error) setError(data.error);
          else if (raw.trimStart().startsWith("<")) {
            const m = raw.match(/"message":"([^"]{5,300})"/);
            setError(
              m
                ? m[1].replace(/\\u003e/g, ">").replace(/\\"/g, '"')
                : `Server error ${res.status}. Check the terminal running npm run dev.`
            );
          } else setError(raw.slice(0, 300) || `Upload failed (${res.status}).`);
          return;
        }

        if (!data) {
          setError("Upload succeeded but the response could not be read.");
          return;
        }

        setResults((prev) => [...prev, ...data.results]);
        onDone?.(data.knowledgeCount);
      } catch (err) {
        setError(
          err instanceof Error
            ? `Could not reach /api/upload: ${err.message}`
            : "Could not reach /api/upload."
        );
      } finally {
        setBusy(false);
      }
    },
    [projectId, kind, onDone]
  );

  const copy = {
    sample: {
      label: "Drop the sample thesis here",
      hint: "One PDF or DOCX. The house style is read from this file.",
    },
    structure: {
      label: "Drop supervisor guidance or a handbook here",
      hint: "Optional. Chapter requirements, word limits, and mandatory sections are read from this file.",
    },
    knowledge: {
      label: "Drop knowledge documents here",
      hint: `${MIN_KNOWLEDGE_DOCS} or more files. PDF, DOCX, or TXT.`,
    },
  }[kind];
  const { label, hint } = copy;

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          upload(e.dataTransfer.files);
        }}
        className="rounded border-2 border-dashed px-6 py-10 text-center transition-colors"
        style={{
          borderColor: dragging ? "var(--iron)" : "var(--rule)",
          background: dragging ? "var(--paper-deep)" : "transparent",
        }}
      >
        <p className="display text-lg">{label}</p>
        <p className="mt-1 text-sm" style={{ color: "var(--ink-soft)" }}>
          {hint}
        </p>

        <label
          className="display mt-5 inline-block cursor-pointer rounded px-5 py-2 text-sm text-white"
          style={{ background: "var(--iron)", opacity: busy ? 0.45 : 1 }}
        >
          {busy ? "Reading files…" : "Choose files"}
          <input
            type="file"
            multiple={kind === "knowledge"}
            accept=".pdf,.docx,.txt"
            disabled={busy}
            onChange={(e) => upload(e.target.files)}
            className="sr-only"
          />
        </label>
      </div>

      {error && (
        <p
          className="mt-4 border-l-2 pl-3 text-sm"
          style={{ borderColor: "var(--pencil)", color: "var(--pencil)" }}
        >
          {error}
        </p>
      )}

      {results.length > 0 && (
        <ul className="mt-5 space-y-2">
          {results.map((r, i) => (
            <li key={i} className="flex items-baseline justify-between text-sm">
              <span className="truncate pr-4">{r.filename}</span>
              <span
                className="mono shrink-0"
                style={{ color: r.error ? "var(--pencil)" : "var(--ink-soft)" }}
              >
                {r.error
                  ? r.error
                  : r.styleProfile
                    ? `${r.styleProfile.citationStyle} · ${r.styleProfile.chapterSequence.length} chapters`
                    : r.structureSpec
                      ? `${r.structureSpec.chapters.length} chapters required`
                      : `${r.chunks} chunks`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
