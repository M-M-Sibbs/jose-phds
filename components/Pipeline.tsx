"use client";

import { motion, AnimatePresence } from "framer-motion";

export type Stage = {
  key: string;
  label: string;
  state: "pending" | "active" | "done";
  detail?: string;
};

export const STAGES: Omit<Stage, "state" | "detail">[] = [
  { key: "research", label: "Deep research" },
  { key: "critique", label: "SMART critique" },
  { key: "writing", label: "Drafting" },
  { key: "humanizing", label: "EPIC humanising" },
  { key: "references", label: "References" },
  { key: "done", label: "Complete" },
];

export function Pipeline({ stages }: { stages: Stage[] }) {
  const doneCount = stages.filter((s) => s.state === "done").length;
  const fill = stages.length > 1 ? (doneCount / (stages.length - 1)) * 100 : 0;

  return (
    <div className="pipeline">
      <div className="pipeline-fill" style={{ height: `calc(${fill}% - 1rem)` }} />

      {stages.map((s) => (
        <div key={s.key} className="relative mb-6 last:mb-0">
          <span className="stage-node" data-state={s.state} aria-hidden />
          <div className="flex flex-col">
            <span
              className="display text-base"
              style={{ color: s.state === "pending" ? "var(--ink-soft)" : "var(--ink)" }}
            >
              {s.label}
            </span>
            <AnimatePresence mode="wait">
              {s.detail && (
                <motion.span
                  key={s.detail}
                  initial={{ opacity: 0, y: -3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mono mt-1"
                  style={{ color: "var(--ink-soft)" }}
                >
                  {s.detail}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>
      ))}
    </div>
  );
}
