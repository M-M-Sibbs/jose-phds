import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env.local");
if (!existsSync(envPath)) {
  console.error("\n  .env.local not found in this folder.");
  console.error("  Run:  copy ENV-TEMPLATE.txt .env.local");
  console.error(`  Looked in: ${process.cwd()}\n`);
  process.exit(1);
}

for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!m) continue;
  const value = m[2].trim().replace(/^["']|["']$/g, "");
  if (value) process.env[m[1]] = value;
}

const results = [];

async function check(name, envVars, fn) {
  const missing = envVars.filter((v) => !process.env[v]);
  if (missing.length) {
    results.push({ name, ok: false, msg: `not set: ${missing.join(", ")}` });
    console.log(`  [ SKIP ] ${name}  --  ${missing.join(", ")} blank in .env.local`);
    return;
  }
  process.stdout.write(`  [ .... ] ${name}`);
  try {
    const detail = await fn();
    results.push({ name, ok: true, msg: detail });
    process.stdout.write(`\r  [  OK  ] ${name}  --  ${detail}\n`);
  } catch (err) {
    const msg = (err?.message ?? String(err)).split("\n")[0].slice(0, 160);
    results.push({ name, ok: false, msg });
    process.stdout.write(`\r  [ FAIL ] ${name}  --  ${msg}\n`);
  }
}

console.log("\nChecking services\n" + "-".repeat(60));

await check("Gemini API", ["GEMINI_API_KEY"], async () => {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const res = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: "Reply with the single word: ready",
    config: { maxOutputTokens: 10 },
  });
  const text = (res.text ?? "").trim();
  if (!text) throw new Error("Empty response from Gemini.");
  return `responded "${text}"`;
});

let embeddingDims = null;
await check("Gemini embeddings", ["GEMINI_API_KEY"], async () => {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const res = await ai.models.embedContent({
    model: "text-embedding-004",
    contents: "dimension probe",
    config: { taskType: "RETRIEVAL_DOCUMENT" },
  });
  const values = res.embeddings?.[0]?.values ?? res.embedding?.values ?? [];
  if (!values.length) throw new Error("No embedding returned.");
  embeddingDims = values.length;
  return `${values.length} dimensions`;
});

await check("Pinecone", ["PINECONE_API_KEY", "PINECONE_INDEX"], async () => {
  const { Pinecone } = await import("@pinecone-database/pinecone");
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const name = process.env.PINECONE_INDEX;
  const list = await pc.listIndexes();
  const found = (list.indexes ?? []).find((i) => i.name === name);
  if (!found) {
    const names = (list.indexes ?? []).map((i) => i.name).join(", ") || "none";
    throw new Error(`No index named "${name}". Indexes on this account: ${names}`);
  }
  const dim = found.dimension;
  if (embeddingDims && dim !== embeddingDims) {
    throw new Error(
      `Index is ${dim}-dim but embeddings are ${embeddingDims}-dim. Recreate with ${embeddingDims} dimensions, cosine metric.`
    );
  }
  await pc.index(name).describeIndexStats();
  return `index "${name}" reachable, ${dim} dimensions`;
});

await check("Postgres", ["DATABASE_URL"], async () => {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    let tables = "schema not pushed yet -- run: npx prisma db push";
    try {
      const count = await prisma.project.count();
      tables = `tables present, ${count} project(s)`;
    } catch {}
    return tables;
  } finally {
    await prisma.$disconnect();
  }
});

await check("Vercel Blob", ["BLOB_READ_WRITE_TOKEN"], async () => {
  const { list } = await import("@vercel/blob");
  const res = await list({ limit: 1, token: process.env.BLOB_READ_WRITE_TOKEN });
  return `store reachable, ${res.blobs.length} blob(s) listed`;
});

await check("Clerk", ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"], async () => {
  const secret = process.env.CLERK_SECRET_KEY;
  const pub = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!secret.startsWith("sk