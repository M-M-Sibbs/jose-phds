/**
 * Validates every external service independently.
 *
 * Run:  node scripts/check-keys.mjs
 *
 * Each check is isolated so a failure names one service rather than
 * surfacing as an opaque 500 from a route that touches four of them.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// --- load .env.local without a dependency -----------------------------------
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

// --- tiny reporter ----------------------------------------------------------
const results = [];
const mask = (v) => (v ? `${v.slice(0, 6)}…${v.slice(-4)}` : "");

async function check(name, envVars, fn, optional = false) {
  const missing = envVars.filter((v) => !process.env[v]);
  if (missing.length) {
    // Optional services are not failures; the app degrades gracefully without them.
    results.push({ name, ok: optional, msg: `not set: ${missing.join(", ")}` });
    console.log(
      `  [ SKIP ] ${name}  —  ${missing.join(", ")} blank in .env.local${
        optional ? "  (optional)" : ""
      }`
    );
    return;
  }
  process.stdout.write(`  [ .... ] ${name}`);
  try {
    const detail = await fn();
    results.push({ name, ok: true, msg: detail });
    process.stdout.write(`\r  [  OK  ] ${name}  —  ${detail}\n`);
  } catch (err) {
    const msg = (err?.message ?? String(err)).split("\n")[0].slice(0, 160);
    results.push({ name, ok: false, msg });
    process.stdout.write(`\r  [ FAIL ] ${name}  —  ${msg}\n`);
  }
}

console.log("\nChecking services\n" + "-".repeat(60));

// --- 1. Gemini --------------------------------------------------------------
await check("Gemini API", ["GEMINI_API_KEY"], async () => {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const res = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: "Reply with the single word: ready",
    // 2.5 models spend tokens on internal reasoning before emitting text, so a
    // tiny cap returns an empty string rather than an error.
    config: { maxOutputTokens: 512 },
  });
  const text = (res.text ?? "").trim();
  if (!text) throw new Error("Key accepted but response was empty - try raising maxOutputTokens.");
  return `responded "${text.slice(0, 40)}"`;
});

// --- 2. Embeddings (dimension must match the Pinecone index) ----------------
// Which models this key can actually call - authoritative, unlike docs.
await check("Available models", ["GEMINI_API_KEY"], async () => {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}&pageSize=200`
  );
  if (!res.ok) throw new Error(`Model list returned ${res.status}`);
  const data = await res.json();
  const names = (data.models ?? [])
    .map((m) => String(m.name).replace(/^models\//, ""))
    .filter((n) => /^gemini-(?:2\.5|3)/.test(n) && !/image|tts|embedding|live|native/.test(n));

  const preferred = ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-pro"];
  const usable = preferred.filter((p) => names.includes(p));

  console.log("");
  names.slice(0, 12).forEach((n) => console.log(`             ${n}`));
  if (names.length > 12) console.log(`             ... ${names.length - 12} more`);
  console.log("");

  if (!usable.length) throw new Error("None of the expected text models are available to this key.");
  return `will use ${usable[0]}`;
});

// Distinguishes "no quota at all" from "too fast just now".
await check("Gemini quota", ["GEMINI_API_KEY"], async () => {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  try {
    await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: "ping",
      config: { maxOutputTokens: 256 },
    });
    return "quota available";
  } catch (err) {
    const msg = String(err?.message ?? err);

    if (/limit:\s*0/.test(msg)) {
      throw new Error("This model has no allowance on your plan (limit: 0). Enable billing on the key's Google Cloud project.");
    }
    if (/quotaMetric|PerMinute/.test(msg)) {
      throw new Error("Per-minute rate limit hit. Wait 60s and rerun - this one clears on its own.");
    }
    if (/RESOURCE_EXHAUSTED|429/.test(msg)) {
      throw new Error("Quota error with no per-model detail: likely a project/billing limit. A Gemini Plus subscription does NOT provide API quota. Check aistudio.google.com/app/apikey.");
    }
    throw err;
  }
});

let embeddingDims = null;
await check("Gemini embeddings", ["GEMINI_API_KEY"], async () => {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const res = await ai.models.embedContent({
    model: "gemini-embedding-001",
    contents: "dimension probe",
    config: { taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 768 },
  });
  const values = res.embeddings?.[0]?.values ?? res.embedding?.values ?? [];
  if (!values.length) throw new Error("No embedding returned.");
  embeddingDims = values.length;
  return `${values.length} dimensions`;
});

// --- 3. Pinecone ------------------------------------------------------------
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
      `Index is ${dim}-dim but embeddings are ${embeddingDims}-dim. Recreate the index with ${embeddingDims} dimensions, cosine metric.`
    );
  }

  await pc.index(name).describeIndexStats();
  return `index "${name}" reachable, ${dim} dimensions`;
});

// --- 4. Postgres ------------------------------------------------------------
await check("Postgres", ["DATABASE_URL"], async () => {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    let tables = "schema not pushed yet — run: npx prisma db push";
    try {
      const count = await prisma.project.count();
      tables = `tables present, ${count} project(s)`;
    } catch {
      /* schema not pushed */
    }
    return tables;
  } finally {
    await prisma.$disconnect();
  }
});

// --- 5. Vercel Blob ---------------------------------------------------------
await check("Vercel Blob", ["BLOB_READ_WRITE_TOKEN"], async () => {
  const { list } = await import("@vercel/blob");
  const res = await list({ limit: 1, token: process.env.BLOB_READ_WRITE_TOKEN });
  return `store reachable, ${res.blobs.length} blob(s) listed`;
}, true);

// --- 6. Clerk ---------------------------------------------------------------
await check(
  "Clerk",
  ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"],
  async () => {
    const secret = process.env.CLERK_SECRET_KEY;
    const pub = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!secret.startsWith("sk_")) throw new Error("CLERK_SECRET_KEY should start with sk_");
    if (!pub.startsWith("pk_")) throw new Error("Publishable key should start with pk_");

    const res = await fetch("https://api.clerk.com/v1/users?limit=1", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (res.status === 401) throw new Error("Clerk rejected the secret key (401).");
    if (!res.ok) throw new Error(`Clerk returned ${res.status}.`);
    const users = await res.json();
    const mode = pub.startsWith("pk_live_") ? "live" : "test";
    return `${mode} keys valid, ${Array.isArray(users) ? users.length : 0} user(s)`;
  },
  true
);

// --- summary ----------------------------------------------------------------
console.log("-".repeat(60));
const failed = results.filter((r) => !r.ok);

if (!failed.length) {
  console.log("\n  All required services reachable. Start the app:\n\n      npm run dev\n");
  process.exit(0);
}

console.log(`\n  ${failed.length} of ${results.length} checks did not pass:\n`);
for (const f of failed) console.log(`    ${f.name}: ${f.msg}`);

console.log(`
  Where to get each value:

    GEMINI_API_KEY        aistudio.google.com  ->  Get API key
    PINECONE_API_KEY      app.pinecone.io  ->  API Keys
    PINECONE_INDEX        index name; must be 768 dimensions, cosine metric,
                          created WITHOUT an integrated embedding model
    DATABASE_URL          neon.tech  ->  create project  ->  connection string
    BLOB_READ_WRITE_TOKEN OPTIONAL - archives original uploads only.
                          vercel.com -> Storage -> Create Blob store
    CLERK_*               OPTIONAL locally - keyless mode works for testing.
                          dashboard.clerk.com  ->  API Keys

  After editing .env.local, rerun this script. No need to restart anything.
`);
process.exit(1);
