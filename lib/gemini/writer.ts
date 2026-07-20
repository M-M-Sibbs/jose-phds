import { generate, MODELS } from "@/lib/gemini/client";
import { asContextBlock } from "@/lib/rag/store";
import { styleToInstruction, type StyleProfile } from "@/lib/rag/style";
import type { ResearchResult } from "@/lib/gemini/research";
import type { CriticalReport } from "@/lib/critical/smart";
import type { Reference } from "@/lib/citations/engine";

export const CHAPTERS = [
  { id: "ch1", title: "Introduction", sections: ["Background", "Problem Statement", "Aim and Objectives", "Research Questions", "Scope", "Delimitations", "Definition of Terms"] },
  { id: "ch2", title: "Literature Review", sections: ["Theoretical Framework", "Thematic Review", "Conceptual Framework", "Research Gaps"] },
  { id: "ch3", title: "Methodology", sections: ["Research Design", "Population and Sampling", "Instrumentation", "Data Collection", "Analysis", "Ethical Considerations"] },
  { id: "ch4", title: "Results", sections: ["Descriptive Findings", "Analytical Findings"] },
  { id: "ch5", title: "Discussion", sections: ["Interpretation", "Relation to Prior Work", "Implications", "Limitations"] },
  { id: "ch6", title: "Conclusion", sections: ["Summary of Findings", "Contribution to Knowledge", "Recommendations", "Future Work"] },
] as const;

const RULES = `Non-negotiable rules:
1. Cite only using the handles supplied ([C3], [W7]). Never invent a handle.
2. Every factual or empirical claim carries a handle. If no handle supports a
   claim, either drop the claim or mark it [SYNTHESIS] to show it is your own
   reasoning over the cited material rather than a sourced fact.
3. Do not restate the same point in different words to add length.
4. Do not open paragraphs with "In today's world", "It is important to note",
   "This chapter will", or similar filler.
5. Refer back to earlier chapters by number where the argument depends on them.`;

export async function writeChapter(opts: {
  chapter: { id: string; title: string; sections: readonly string[]; guidance?: string };
  topic: string;
  objectives: string;
  style: StyleProfile;
  research: ResearchResult;
  critique: CriticalReport;
  references: Reference[];
  priorSummaries: string;
}) {
  const { chapter, topic, objectives, style, research, critique, references, priorSummaries } = opts;

  const { text } = await generate(
    `Write ${chapter.title} of a doctoral thesis.

TOPIC: ${topic}

OBJECTIVES:
${objectives}

REQUIRED SECTIONS: ${chapter.sections.join(", ")}
${chapter.guidance ? `INSTITUTIONAL REQUIREMENT FOR THIS CHAPTER:\n${chapter.guidance}` : ""}

${styleToInstruction(style)}

ARGUMENT OUTLINE (settled in the critical pass — follow it):
${critique.argumentOutline.map((a, i) => `${i + 1}. ${a}`).join("\n")}

CLAIMS THE EVIDENCE CANNOT SUPPORT (do not assert these):
${critique.unsupportedClaims.join("\n") || "none"}

EVIDENCE:
${asContextBlock(research.corpus)}

RESEARCH BRIEF:
${JSON.stringify(research.brief, null, 2)}

AVAILABLE CITATION HANDLES:
${references.map((r) => `[${r.handle}] ${r.title}`).join("\n")}

WHAT EARLIER CHAPTERS ESTABLISHED:
${priorSummaries || "This is the first chapter."}

${RULES}

Write the full chapter in Markdown. Doctoral depth and register throughout.`,
    { role: "writing", temperature: 0.45, maxOutputTokens: 8192 }
  );

  return text;
}

export async function summariseChapter(title: string, body: string) {
  const { text } = await generate(
    `In 120 words, state what "${title}" established, so later chapters can
build on it without contradiction. Claims only, no preamble.\n\n${body.slice(0, 20000)}`,
    { role: "fast", temperature: 0.2, maxOutputTokens: 400 }
  );
  return text;
}
