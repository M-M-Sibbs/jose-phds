import { generateJSON, MODELS } from "@/lib/gemini/client";

export type StyleProfile = {
  citationStyle: "APA7" | "Harvard" | "IEEE" | "Chicago";
  chapterSequence: string[];
  headingPattern: string;
  sentenceLength: "short" | "moderate" | "long";
  voice: string;
  tenseConventions: string;
  personConventions: string;
  formattingNotes: string[];
};

/**
 * Reads the uploaded institutional sample and reports how *that university*
 * writes — not how theses are written in general. Only the opening and a
 * mid-document slice are sent; that is enough to fix conventions without
 * paying for the whole document.
 */
export async function extractStyle(sampleText: string): Promise<StyleProfile> {
  const head = sampleText.slice(0, 12000);
  const middle = sampleText.slice(
    Math.floor(sampleText.length / 2),
    Math.floor(sampleText.length / 2) + 6000
  );

  return generateJSON<StyleProfile>(
    `Analyse this thesis excerpt and report its house conventions.

OPENING:
${head}

MID-DOCUMENT:
${middle}

Return JSON with exactly these keys:
citationStyle (one of APA7, Harvard, IEEE, Chicago — infer from the in-text citations),
chapterSequence (array of chapter titles in order),
headingPattern (how headings are numbered and capitalised),
sentenceLength (short|moderate|long),
voice (active/passive balance as observed),
tenseConventions (which tense is used for literature, methods, results),
personConventions (first person, third person, or impersonal),
formattingNotes (array of other conventions worth reproducing).

Describe what is actually present. Do not prescribe best practice.`,
    { role: "fast", temperature: 0.1 }
  );
}

export function styleToInstruction(s: StyleProfile) {
  return `Match the institutional template exactly:
- Citation style: ${s.citationStyle}
- Heading pattern: ${s.headingPattern}
- Sentence length: ${s.sentenceLength}
- Voice: ${s.voice}
- Tense: ${s.tenseConventions}
- Person: ${s.personConventions}
${s.formattingNotes.map((n) => `- ${n}`).join("\n")}`;
}
