import { generate, generateJSON, type Citation } from "@/lib/gemini/client";
import { retrieve, asContextBlock, type Retrieved } from "@/lib/rag/store";

export type ResearchBrief = {
  themes: { name: string; summary: string; sourceHandles: string[] }[];
  definitions: { term: string; definition: string; sourceHandle: string }[];
  statistics: { claim: string; value: string; sourceHandle: string }[];
  methodologies: string[];
  gaps: string[];
  opportunities: string[];
};

export type ResearchResult = {
  brief: ResearchBrief;
  corpus: Retrieved[];
  external: Citation[];
  /** Set when external search was skipped or failed; surfaced as a warning. */
  searchNote: string | null;
};

/**
 * Two-stage research.
 *
 * Stage 1 searches the web with Gemini's Search grounding, which returns
 * resolvable source URLs alongside the text. Only publicly accessible pages
 * are reached — the app does not attempt to defeat paywalls or scrape
 * restricted databases.
 *
 * Stage 2 fuses those findings with passages retrieved from the user's own
 * uploaded corpus, and forces every extracted item to name the handle it
 * came from. Items with no handle are dropped rather than guessed at.
 */
export async function deepResearch(
  projectId: string,
  topic: string,
  questions: string
): Promise<ResearchResult> {
  const corpus = await retrieve(projectId, `${topic}\n${questions}`, 16);

  /**
   * Grounded web search is optional.
   *
   * Google Search grounding is metered against a much smaller bucket than plain
   * generation (and a known bug charges it to the 20/day free-tier request
   * quota rather than the 5,000/day grounding quota). A 429 here would abort a
   * run whose primary evidence - the user's own corpus - is already retrieved.
   * So the search is best-effort: if it fails, research continues corpus-only
   * and the caller is told external sources are absent.
   */
  let web: { text: string; citations: Citation[] } = { text: "", citations: [] };
  let searchNote: string | null = null;

  if (process.env.GEMINI_DISABLE_GROUNDING === "true") {
    searchNote = "External web search disabled by configuration; using uploaded documents only.";
  } else {
    try {
      web = await generate(
        `Survey the current scholarly literature on: ${topic}

Research questions:
${questions}

Report, using only sources you can actually reach:
- established definitions and who established them
- reported statistics with the study that reported them
- methodologies in current use
- developments from the last three years
- gaps the literature itself names as open

Attribute every factual statement to a named source. If you cannot reach a
source for a claim, omit the claim.`,
        { role: "reasoning", grounded: true, temperature: 0.3 }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      searchNote = /429|RESOURCE_EXHAUSTED|quota/i.test(msg)
        ? "External web search was rate-limited, so this brief draws only on your uploaded documents. Chapters will cite [C] handles but no [W] sources."
        : `External web search failed (${msg.slice(0, 120)}); continuing with uploaded documents only.`;
    }
  }

  const external = web.citations;

  // A grounded search that returns nothing usually means the tool call failed
  // rather than that the topic has no literature. Continuing would produce a
  // brief with no external evidence and no explanation of why.
  if (!corpus.length && !web.text.trim()) {
    throw new Error(
      "No evidence found: no passages matched your uploaded documents and the web search returned nothing. Check that the knowledge documents indexed correctly (chunk counts should be shown after upload) and that the research topic matches their subject matter."
    );
  }

  const brief = await generateJSON<ResearchBrief>(
    `Consolidate these two evidence sets into a structured research brief.

UPLOADED CORPUS (handles [C1]..[Cn]):
${asContextBlock(corpus)}

WEB FINDINGS (handles [W1]..[Wn] map to the numbered sources below):
${web.text}

SOURCES:
${external.map((c, i) => `[W${i + 1}] ${c.title ?? c.uri} — ${c.uri}`).join("\n")}

Return JSON: { themes, definitions, statistics, methodologies, gaps, opportunities }.

Every theme, definition, and statistic must carry the handle it came from
([C3], [W7], etc). Drop any item you cannot attach a handle to. Never invent
a handle that does not appear above.`,
    { role: "reasoning", temperature: 0.2 }
  );

  if (!brief || typeof brief !== "object") {
    throw new Error("The research brief came back empty or malformed.");
  }

  return {
    brief: {
      themes: brief.themes ?? [],
      definitions: brief.definitions ?? [],
      statistics: brief.statistics ?? [],
      methodologies: brief.methodologies ?? [],
      gaps: brief.gaps ?? [],
      opportunities: brief.opportunities ?? [],
    },
    corpus,
    external,
    searchNote,
  };
}
