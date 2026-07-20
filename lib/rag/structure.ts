import { generateJSON, MODELS } from "@/lib/gemini/client";

export type StructureSpec = {
  chapters: { title: string; sections: string[]; guidance: string }[];
  wordCountGuidance: string | null;
  mandatoryElements: string[];
  prohibitions: string[];
  source: string;
};

/**
 * Reads supervisor guidance, a department handbook, or a proposal template and
 * extracts the structure the student is actually required to follow.
 *
 * This is separate from style learning. A sample thesis shows how the
 * institution writes; a handbook states what it demands. When the two conflict,
 * the handbook wins, because that is what the examiner marks against.
 */
export async function extractStructure(
  text: string,
  filename: string
): Promise<StructureSpec> {
  const spec = await generateJSON<Omit<StructureSpec, "source">>(
    `This document specifies how a thesis at this institution must be structured.
Extract the requirements it states.

DOCUMENT:
${text.slice(0, 20000)}

Return JSON:
{
  "chapters": [{ "title", "sections": [], "guidance": "what this chapter must contain" }],
  "wordCountGuidance": "stated limits, or null if unstated",
  "mandatoryElements": ["things the document requires, e.g. a declaration page"],
  "prohibitions": ["things it forbids"]
}

Extract only what the document states. Where it is silent, use null or an empty
array rather than supplying conventional academic defaults — a requirement this
student does not actually have is worse than a missing one.`,
    { role: "fast", temperature: 0.1 }
  );

  // An empty extraction means the document had no structural requirements in
  // it (or the model failed). Saving it would display "0 chapters required"
  // and silently override the default outline with nothing.
  if (!spec?.chapters?.length) {
    throw new Error(
      "No chapter structure found in this document. Upload supervisor guidance or a handbook that lists required chapters, or skip this step to use the standard outline."
    );
  }

  return {
    ...spec,
    chapters: spec.chapters,
    mandatoryElements: spec.mandatoryElements ?? [],
    prohibitions: spec.prohibitions ?? [],
    source: filename,
  };
}

/**
 * Merges an extracted structure with the built-in default outline.
 * Institution-specified chapters replace the defaults entirely when present.
 */
export function resolveOutline<T extends { id: string; title: string; sections: readonly string[] }>(
  defaults: readonly T[],
  spec: StructureSpec | null
) {
  if (!spec?.chapters?.length) return defaults.map((c) => ({ ...c, guidance: "" }));

  return spec.chapters.map((c, i) => ({
    id: `ch${i + 1}`,
    title: c.title,
    sections: c.sections.length ? c.sections : [...(defaults[i]?.sections ?? [])],
    guidance: c.guidance ?? "",
  }));
}

export function structureToInstruction(spec: StructureSpec | null) {
  if (!spec) return "";
  const parts = [`Structural requirements from ${spec.source}:`];
  if (spec.wordCountGuidance) parts.push(`- Length: ${spec.wordCountGuidance}`);
  spec.mandatoryElements.forEach((e) => parts.push(`- Required: ${e}`));
  spec.prohibitions.forEach((p) => parts.push(`- Not permitted: ${p}`));
  return parts.join("\n");
}
