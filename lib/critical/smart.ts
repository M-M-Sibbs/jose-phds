import { generateJSON, MODELS } from "@/lib/gemini/client";
import type { ResearchResult } from "@/lib/gemini/research";
import { asContextBlock } from "@/lib/rag/store";

export type SmartVerdict = {
  criterion: "Specific" | "Measurable" | "Achievable" | "Relevant" | "TimeBound";
  passed: boolean;
  finding: string;
  revision: string;
};

export type CriticalReport = {
  verdicts: SmartVerdict[];
  unsupportedClaims: string[];
  argumentOutline: string[];
  writeReady: boolean;
};

/**
 * Runs before any prose is written. The SMART pass is what stops the writing
 * engine from producing fluent text around a claim nothing in the evidence
 * base supports — it decides what CAN be argued before deciding how to say it.
 */
export async function criticalPass(
  chapter: string,
  objectives: string,
  research: ResearchResult
): Promise<CriticalReport> {
  const report = await generateJSON<CriticalReport>(
    `You are examining a doctoral chapter plan before drafting begins.

CHAPTER: ${chapter}

OBJECTIVES:
${objectives}

AVAILABLE EVIDENCE:
${asContextBlock(research.corpus)}

RESEARCH BRIEF:
${JSON.stringify(research.brief, null, 2)}

Assess against SMART:
- Specific: is the argument of this chapter precisely stated, or vague?
- Measurable: is every intended claim supportable by the evidence above?
- Achievable: is the methodology realistic at doctoral scale?
- Relevant: does the chapter answer the stated objectives?
- TimeBound: does the research timeline hold together?

Return JSON:
{
  "verdicts": [{ "criterion", "passed", "finding", "revision" }],
  "unsupportedClaims": [claims the plan implies but the evidence cannot carry],
  "argumentOutline": [ordered argumentative moves the chapter should make],
  "writeReady": boolean
}

Be adversarial. A supervisor who passes weak work is not doing the student a
favour. If evidence is thin, say so and set writeReady false.`,
    { role: "reasoning", temperature: 0.2 }
  );

  return report;
}
