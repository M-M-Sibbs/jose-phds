/**
 * Minimum knowledge documents before generation is allowed.
 *
 * The floor exists because retrieval quality collapses on a thin corpus: with
 * too few sources the SMART pass finds nothing to support claims with, and the
 * writing engine gets pushed toward unsupported assertion. Six is a workable
 * lower bound for a chapter-level draft; more is better for a full thesis.
 *
 * This constant is imported by client components, so it cannot read
 * process.env at runtime - Next.js only inlines NEXT_PUBLIC_* into the browser
 * bundle. Change the number here to change the requirement everywhere.
 */
export const MIN_KNOWLEDGE_DOCS = 6;
