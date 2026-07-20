import type { Citation } from "@/lib/gemini/client";
import type { Retrieved } from "@/lib/rag/store";
import type { StyleProfile } from "@/lib/rag/style";

export type Reference = {
  handle: string;
  authors: string | null;
  year: string | null;
  title: string;
  container: string | null;
  uri: string | null;
  origin: "corpus" | "web";
  /** True when metadata is complete enough to format a bibliography entry. */
  verified: boolean;
};

/**
 * Builds the reference pool. Nothing is invented here: a reference exists only
 * because a corpus document or a grounded search result produced it.
 * Incomplete metadata is marked unverified and surfaced to the user for
 * checking rather than filled in with plausible-looking guesses.
 */
export function buildReferencePool(
  corpus: Retrieved[],
  external: Citation[]
): Reference[] {
  const refs: Reference[] = [];
  const seen = new Set<string>();

  corpus.forEach((c) => {
    if (seen.has(c.documentId)) return;
    seen.add(c.documentId);
    const parsed = parseFilenameMetadata(c.documentTitle);
    refs.push({
      handle: `C${refs.length + 1}`,
      authors: parsed.authors,
      year: parsed.year,
      title: parsed.title,
      container: null,
      uri: null,
      origin: "corpus",
      verified: Boolean(parsed.authors && parsed.year),
    });
  });

  external.forEach((e, i) => {
    refs.push({
      handle: `W${i + 1}`,
      authors: null,
      year: null,
      title: e.title ?? e.uri,
      container: hostOf(e.uri),
      uri: e.uri,
      origin: "web",
      verified: false,
    });
  });

  return refs;
}

/** Formats one entry. Unverified entries carry a visible review marker. */
export function formatReference(r: Reference, style: StyleProfile["citationStyle"]) {
  const authors = r.authors ?? "[author unverified]";
  const year = r.year ?? "n.d.";
  const flag = r.verified ? "" : "  ⚠ VERIFY";

  switch (style) {
    case "IEEE":
      return `${authors}, "${r.title}," ${r.container ?? ""} ${year}.${r.uri ? ` [Online]. Available: ${r.uri}` : ""}${flag}`;
    case "Chicago":
      return `${authors}. "${r.title}." ${r.container ?? ""} (${year}).${r.uri ? ` ${r.uri}.` : ""}${flag}`;
    case "Harvard":
      return `${authors} (${year}) ${r.title}. ${r.container ?? ""}${r.uri ? ` Available at: ${r.uri}` : ""}${flag}`;
    default:
      return `${authors} (${year}). ${r.title}. ${r.container ?? ""}${r.uri ? ` ${r.uri}` : ""}${flag}`;
  }
}

export function buildBibliography(
  refs: Reference[],
  style: StyleProfile["citationStyle"]
) {
  const used = refs.slice().sort((a, b) => (a.authors ?? "").localeCompare(b.authors ?? ""));
  return used.map((r) => formatReference(r, style)).join("\n\n");
}

/**
 * Finds handles the draft cites that no source backs. These are reported to
 * the user; they are never silently resolved to a nearby real reference.
 */
export function findOrphanCitations(draft: string, refs: Reference[]) {
  const known = new Set(refs.map((r) => r.handle));
  const cited = new Set(
    [...draft.matchAll(/\[([CW]\d+)\]/g)].map((m) => m[1])
  );
  return [...cited].filter((h) => !known.has(h));
}

function parseFilenameMetadata(name: string) {
  const clean = name.replace(/\.(pdf|docx?|txt)$/i, "").replace(/[_]+/g, " ");
  const year = clean.match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
  const authors = clean.match(/^([A-Z][a-zA-Z'-]+(?:\s(?:et al\.?|and|&)\s[A-Z][a-zA-Z'-]+)?)/)?.[1] ?? null;
  return { authors, year, title: clean };
}

function hostOf(uri: string) {
  try {
    return new URL(uri).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
