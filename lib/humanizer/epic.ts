import { generate, MODELS } from "@/lib/gemini/client";

/**
 * EPIC — four sequential rewriting passes.
 *
 *   E  Empathetic     make it land for a human reader
 *   P  Purpose        keep every paragraph answering the research question
 *   I  Impact         emphasise findings, contributions, novelty
 *   C  Communicate    flow, transitions, consistency, logical progression
 *
 * Each pass is narrow on purpose. A single "make this sound human" prompt
 * tends to flatten the argument and drift off the citations; four constrained
 * passes each fix one thing while an invariant guard protects the rest.
 */

const INVARIANT = `Absolute constraints for every pass:
- Do not add, remove, or renumber any citation handle ([C3], [W7], [SYNTHESIS]).
- Do not change any factual claim, statistic, or finding.
- Do not change section headings.
- Preserve academic register. Humanising means readable, not casual.
- Return the full revised text only. No commentary about your edits.`;

export type PassName = "empathetic" | "purpose" | "impact" | "communicate";

const PROMPTS: Record<PassName, string> = {
  empathetic: `Pass 1 — Empathetic layer.

Rewrite so a human reader can follow the reasoning without rereading. Break
sentences that carry more than one idea. Replace nominalisations with verbs
("carried out an investigation of" becomes "investigated"). Vary sentence
length; uniform rhythm is the clearest tell of machine prose. Where a passage
assumes knowledge the reader may not have, make the bridge explicit.`,

  purpose: `Pass 2 — Purpose preservation.

Check every paragraph against the research questions. A paragraph that does
not advance an objective is either cut or given an explicit sentence tying it
back. Where a paragraph drifted from the claim its topic sentence promised,
realign it. Report nothing; just return the corrected text.`,

  impact: `Pass 3 — Emphasis layer.

Findings, contributions, and novel arguments are currently buried in
mid-paragraph. Move them to positions of emphasis: the start or end of a
paragraph, or their own sentence. Strip hedging stacked on hedging ("it may
possibly be suggested that" becomes "this suggests"). Keep single hedges where
the evidence is genuinely tentative — overclaiming is worse than flat prose.`,

  communicate: `Pass 4 — Communication layer.

Final pass. Fix transitions between paragraphs and sections so each follows
from the last. Enforce consistent terminology — one concept, one name,
throughout. Check that the logical progression holds end to end and that
cross-references to other chapters are accurate. Remove any remaining
repetition across paragraphs.`,
};

export async function runPass(text: string, pass: PassName, researchQuestions?: string) {
  const { text: out } = await generate(
    `${PROMPTS[pass]}

${pass === "purpose" && researchQuestions ? `RESEARCH QUESTIONS:\n${researchQuestions}\n` : ""}
${INVARIANT}

TEXT:
${text}`,
    { role: "writing", temperature: 0.6, maxOutputTokens: 8192 }
  );
  return out;
}

/**
 * Passes to run. Each is a separate API call, so a six-chapter thesis costs
 * 24 requests for humanising alone. On a constrained quota, set
 * EPIC_PASSES=communicate (or a comma-separated subset) to cut that down.
 * The default is all four, in order.
 */
export function activePasses(): PassName[] {
  const all: PassName[] = ["empathetic", "purpose", "impact", "communicate"];
  const configured = process.env.EPIC_PASSES;
  if (!configured) return all;

  const requested = configured
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p): p is PassName => all.includes(p as PassName));

  return requested.length ? all.filter((p) => requested.includes(p)) : all;
}

export async function humanize(
  text: string,
  researchQuestions: string,
  onPass?: (pass: PassName) => void
) {
  const passes = activePasses();
  let current = text;

  for (const pass of passes) {
    onPass?.(pass);
    const next = await runPass(current, pass, researchQuestions);
    // A pass that loses citations has failed its invariant — keep the prior draft.
    if (countHandles(next) < countHandles(current)) continue;
    current = next;
  }

  return current;
}

function countHandles(t: string) {
  return (t.match(/\[[CW]\d+\]/g) ?? []).length;
}
