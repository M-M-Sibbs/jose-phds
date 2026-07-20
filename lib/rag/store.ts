import { Pinecone } from "@pinecone-database/pinecone";
import { embedPassages, embedQuery } from "@/lib/embeddings/embed";
import type { Chunk } from "@/lib/rag/chunk";

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const index = pc.index(process.env.PINECONE_INDEX ?? "jose-phds");

export type Retrieved = {
  text: string;
  score: number;
  documentId: string;
  documentTitle: string;
  section: string | null;
};

/** Each project gets its own namespace, so one user's corpus never leaks into another's. */
const ns = (projectId: string) => index.namespace(`project_${projectId}`);

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
    // Below this score the passage is usually off-topic noise that would
    // pull the writing engine toward unsupported claims.
    .filter((m) => (m.score ?? 0) > 0.55)
    .map((m) => ({
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
