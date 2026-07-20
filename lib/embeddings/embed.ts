import pLimit from "p-limit";
import { getClient, resolveModel, EMBEDDING_DIMENSIONS, withRetry } from "@/lib/gemini/client";

// gemini-embedding-001 accepts one input text per request, so batching happens
// here with bounded concurrency rather than in a single multi-input call.
const limit = pLimit(2);

async function embedOne(text: string, taskType: string): Promise<number[]> {
  const model = await resolveModel("embedding");

  const res: any = await withRetry(() => getClient().models.embedContent({
    model,
    contents: text,
    config: {
      taskType,
      outputDimensionality: EMBEDDING_DIMENSIONS,
    },
  }));

  const values: number[] =
    res.embeddings?.[0]?.values ?? res.embedding?.values ?? [];

  if (!values.length) throw new Error("Embedding request returned no vector.");

  // Truncated embeddings are not unit length, and cosine similarity assumes
  // normalized vectors. Renormalizing keeps Pinecone scores comparable.
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? values.map((v) => v / norm) : values;
}

/** Embeds corpus passages for storage. */
export function embedPassages(texts: string[]) {
  return Promise.all(
    texts.map((t) => limit(() => embedOne(t, "RETRIEVAL_DOCUMENT")))
  );
}

/** Embeds a search query. Uses the matching task type so scores are calibrated. */
export function embedQuery(text: string) {
  return embedOne(text, "RETRIEVAL_QUERY");
}
