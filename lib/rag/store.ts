import { Pinecone } from "@pinecone-database/pinecone";
import { embedPassages, embedQuery } from "@/lib/embeddings/embed";
import type { Chunk } from "@/lib/rag/chunk";

/**
 * Lazy Pinecone client.
 *
 * Constructing the client at module load makes every route that imports this
 * file - including /api/projects, which only needs the database - crash during
 * `next build` when PINECONE_API_KEY is absent at build time. Deferring it to
 * first use fixes the build and means a missing key surfaces only on a request
 * that actually needs the vector store.
 */
let _index: ReturnType<Pinecone["index"]> | null = null;

function getIndex() {
  if (_index) return _index;
  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "PINECONE_API_KEY is not set. Add it to .env.local (local) or Vercel > Settings > Environment Variables."
    );
  }
  _index = new Pinecone({ apiKey }).index(
    process.env.PINECONE_INDEX ?? "jose-phds"
  );
  return _index;
}

export type Retrieved = {
  text: string;
  score: number;
  documentId: string;
  documentTitle: string;
  section: string | null;
};

/** Each project gets its own namespace, so one user's corpus never leaks into another's. */
const ns = (projectId: string) => getIndex().namespace(`project_${projectId}`);

export async function indexChunks(
  projectId: string,
  documentId: string,
  documentTitle: string,
  chunks: Chunk[]
) {
  const vectors = await embedPassages(chunks.map((c) => c.text));

  const records = chunks.map((c, i) => ({
    id: `${documentId}#${c.index}`,
    values: vectors[i],
    metadata: {
      text: c.text,
      documentId,
      documentTitle,
      section: c.section ?? "",
    },
  }));

  for (let i = 0; i < records.length; i += 100) {
    await ns(projectId).upsert(records.slice(i, i + 100));
  }

  return records.length;
}

export async function retrieve(
  projectId: string,
  query: string,
  topK = 12
): Promise<Retrieved[]> {
  const vector = await embedQuery(query);
  const res = await ns(projectId).query({
    vector,
    topK,
    includeMetadata: true,
  });

  return (res.matches ?? [])
    .filter((m: { score?: number }) => (m.score ?? 0) > 0.55)
    .map((m: { score?: number; metadata?: Record<string, unknown> }) => ({
      text: String(m.metadata?.text ?? ""),
      score: m.score ?? 0,
      documentId: String(m.metadata?.documentId ?? ""),
      documentTitle: String(m.metadata?.documentTitle ?? ""),
      section: (m.metadata?.section as string) || null,
    }));
}

export async function dropProject(projectId: string) {
  await ns(projectId).deleteAll();
}

/** Formats retrieved passages for a prompt with stable [C1]..[Cn] handles. */
export function asContextBlock(passages: Retrieved[]) {
  return passages
    .map(
      (p, i) =>
        `[C${i + 1}] ${p.documentTitle}${p.section ? ` — ${p.section}` : ""}\n${p.text}`
    )
    .join("\n\n---\n\n");
}
