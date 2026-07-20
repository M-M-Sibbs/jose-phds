import { GoogleGenAI } from "@google/genai";

/**
 * Single Gemini client.
 *
 * The API key is read from process.env at runtime only. It is never bundled
 * into client code, never written to disk, and never committed to git.
 * Set it in Vercel > Settings > Environment Variables.
 */
let _client: GoogleGenAI | null = null;

/**
 * Resolved on first use, not at import time.
 *
 * Throwing during module load takes down the entire route before any handler
 * runs, which surfaces to the user as an opaque HTML 500. Deferring the check
 * lets the route return a readable message instead.
 */
export function getClient(): GoogleGenAI {
  if (_client) return _client;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to .env.local (local) or Vercel > Settings > Environment Variables, then restart the dev server."
    );
  }

  _client = new GoogleGenAI({ apiKey });
  return _client;
}

/**
 * gemini-embedding-001 defaults to 3072 dimensions. We request 768 to keep the
 * Pinecone index small and cheap; the model supports truncation natively.
 * This value MUST match the Pinecone index dimension exactly.
 */
export const EMBEDDING_DIMENSIONS = 768;

/**
 * Model selection.
 *
 * Model availability shifts: Google removed the Pro series from the free tier
 * in April 2026, deprecated 2.0 Flash on 1 June 2026, and closed
 * gemini-2.5-flash-lite to new accounts. Hardcoding a single ID guarantees a
 * 404 or 429 eventually, so each role lists candidates in preference order and
 * resolveModel() picks the first one this API key can actually call.
 *
 * Override any role explicitly in .env.local, e.g.
 *   GEMINI_MODEL_WRITING=gemini-3-flash-preview
 */
const CANDIDATES = {
  reasoning: [
    process.env.GEMINI_MODEL_REASONING,
    process.env.GEMINI_USE_PRO === "true" ? "gemini-2.5-pro" : null,
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
  ],
  writing: [
    process.env.GEMINI_MODEL_WRITING,
    process.env.GEMINI_USE_PRO === "true" ? "gemini-2.5-pro" : null,
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
  ],
  fast: [
    process.env.GEMINI_MODEL_FAST,
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
  ],
  embedding: [
    process.env.GEMINI_MODEL_EMBEDDING,
    "gemini-embedding-001",
  ],
} as const;

let _available: Set<string> | null = null;

/** Model IDs this key can call, from the API itself rather than documentation. */
async function listAvailable(): Promise<Set<string>> {
  if (_available) return _available;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}&pageSize=200`
    );
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    _available = new Set(
      (data.models ?? []).map((m: any) => String(m.name).replace(/^models\//, ""))
    );
  } catch {
    // If discovery fails, fall through to the first candidate and let the
    // actual call report the real error.
    _available = new Set();
  }
  return _available!;
}

const _resolved = new Map<string, string>();

export async function resolveModel(
  role: "reasoning" | "writing" | "fast" | "embedding"
): Promise<string> {
  const cached = _resolved.get(role);
  if (cached) return cached;

  const candidates = CANDIDATES[role].filter(Boolean) as string[];
  const available = await listAvailable();

  const pick =
    candidates.find((c) => available.has(c)) ?? candidates[0];
  _resolved.set(role, pick);
  return pick;
}

/** Synchronous fallbacks, used only where a model name is needed before await. */
export const MODELS = {
  reasoning: "gemini-3-flash-preview",
  writing: "gemini-3-flash-preview",
  fast: "gemini-3-flash-preview",
  embedding: "gemini-embedding-001",
} as const;

export type Citation = { title: string | null; uri: string };

type GenOpts = {
  model?: string;
  /** Preferred over `model`: resolves to whatever this key can actually call. */
  role?: "reasoning" | "writing" | "fast";
  system?: string;
  temperature?: number;
  json?: boolean;
  /** Enables Google Search grounding so answers carry resolvable source URLs. */
  grounded?: boolean;
  maxOutputTokens?: number;
};

/** True for rate limits and transient server faults - worth retrying. */
function isRetryable(err: any) {
  const msg = String(err?.message ?? err);

  // Model withdrawn or renamed - retrying the same ID cannot help.
  if (/\b404\b|no longer available|is not found/i.test(msg)) return false;

  // A per-DAY quota does not clear on any timescale worth waiting for; it
  // resets at midnight Pacific. The stated retryDelay (often ~60s) is
  // misleading, so retrying just spends wall-clock time to fail again.
  if (/PerDay|GenerateRequestsPerDayPerProjectPerModel/i.test(msg)) return false;

  // `limit: 0` means the model has no free-tier allowance at all. Retrying
  // cannot succeed - surface it immediately with an actionable message.
  if (/limit:\s*0/.test(msg)) return false;

  return /\b429\b|RESOURCE_EXHAUSTED|quota|\b503\b|\b500\b|UNAVAILABLE|overloaded/i.test(msg);
}

/**
 * How long to wait before retrying.
 *
 * Gemini usually states a retryDelay. When it does not - as with bare
 * project-level 429s that carry no quota breakdown - back off far more
 * conservatively, because the limit being hit is unknown and hammering it
 * makes things worse.
 */
function retryDelayMs(err: any, attempt: number): number {
  const msg = String(err?.message ?? err);
  const stated =
    msg.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/) ??
    msg.match(/retry in (\d+(?:\.\d+)?)s/i);
  if (stated) return Math.min(Number(stated[1]) * 1000 + 1000, 65000);

  // No stated delay and no per-model detail: 15s, 30s, 60s.
  if (/RESOURCE_EXHAUSTED|\b429\b/.test(msg)) {
    return Math.min(15000 * 2 ** attempt, 60000);
  }

  return 2000 * (2 ** attempt - 1) + 2000;
}

/**
 * Retries with exponential backoff.
 *
 * Free-tier Gemini enforces per-minute limits, so a burst of calls will hit 429
 * even when the daily quota is nowhere near spent. Waiting and retrying turns a
 * hard failure into a slow success. A daily quota exhaustion still fails, but
 * only after the delays confirm it is not transient.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw decorate(err);
      await new Promise((r) => setTimeout(r, retryDelayMs(err, i)));
    }
  }
  throw decorate(lastErr);
}

/** Rewrites provider errors into something the user can act on. */
function decorate(err: unknown): unknown {
  const msg = String((err as any)?.message ?? err);

  const daily = msg.match(/quotaValue":\s*"(\d+)"/);
  if (/PerDay/i.test(msg)) {
    return new Error(
      `Daily Gemini quota exhausted (${daily?.[1] ?? "free tier"} requests/day on this model). This resets at midnight Pacific time, not in the ~60s the API suggests. Your progress is saved - press Resume tomorrow, or enable billing on the key's Google Cloud project. Set EPIC_PASSES=impact,communicate in .env.local to halve the requests a run needs.`
    );
  }
  return err;
}

export async function generate(prompt: string, opts: GenOpts = {}) {
  const {
    role,
    system,
    temperature = 0.4,
    json = false,
    grounded = false,
    maxOutputTokens = 8192,
  } = opts;

  const model = opts.model ?? (await resolveModel(role ?? "writing"));

  // When JSON is requested but grounding blocks the mime type, say so in the
  // prompt instead.
  const effectivePrompt =
    json && grounded
      ? `${prompt}\n\nRespond with valid JSON only. No markdown fences, no commentary before or after.`
      : prompt;

  const res: any = await withRetry(() => getClient().models.generateContent({
    model,
    contents: effectivePrompt,
    config: {
      systemInstruction: system,
      temperature,
      maxOutputTokens,
      // Grounding and forced JSON output are mutually exclusive: the API
      // rejects responseMimeType when a tool is attached. Grounded calls fall
      // back to prompt-level JSON instruction, which parseJSON then cleans up.
      ...(json && !grounded ? { responseMimeType: "application/json" } : {}),
      ...(grounded ? { tools: [{ googleSearch: {} }] } : {}),
    },
  }));

  return {
    text: res.text ?? "",
    citations: extractGroundingCitations(res),
  };
}

/** A 404 means the model was withdrawn; drop caches so the next call re-resolves. */
export function invalidateModelCache() {
  _resolved.clear();
  _available = null;
}

export async function generateJSON<T>(
  prompt: string,
  opts: GenOpts = {}
): Promise<T> {
  const { text } = await generate(prompt, { ...opts, json: true });
  return parseJSON<T>(text);
}

/**
 * Parses model output that is supposed to be JSON.
 *
 * responseMimeType asks for pure JSON but models still sometimes wrap it in
 * markdown fences or add a sentence of preamble, and a bare JSON.parse then
 * throws with a message that says nothing useful about which step failed.
 * This strips the common wrappers, falls back to extracting the outermost
 * brace-delimited object, and otherwise reports what it actually received.
 */
export function parseJSON<T>(raw: string): T {
  const text = (raw ?? "").trim();

  if (!text) {
    throw new Error(
      "The model returned an empty response. This usually means maxOutputTokens was consumed by reasoning before any text was produced."
    );
  }

  const candidates = [
    text,
    text.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim(),
  ];

  // Outermost { ... } or [ ... ], for when the model adds commentary.
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) candidates.push(objMatch[0]);
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) candidates.push(arrMatch[0]);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try the next shape */
    }
  }

  throw new Error(
    `The model did not return valid JSON. First 300 characters received: ${text.slice(0, 300)}`
  );
}

/**
 * Pulls real, resolvable URLs out of Gemini's grounding metadata.
 * These are the only external sources the citation engine will accept —
 * anything the model states without a grounding chunk gets flagged, not cited.
 */
function extractGroundingCitations(res: any): Citation[] {
  const chunks = res?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  return chunks
    .map((c: any) => ({ title: c?.web?.title ?? null, uri: c?.web?.uri ?? null }))
    .filter((c: any): c is Citation => Boolean(c.uri));
}
