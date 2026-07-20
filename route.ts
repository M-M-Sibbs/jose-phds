import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { put } from "@vercel/blob";
import { extractText } from "@/lib/parse/extract";
import { chunkDocument } from "@/lib/rag/chunk";
import { indexChunks } from "@/lib/rag/store";
import { extractStyle } from "@/lib/rag/style";
import { extractStructure } from "@/lib/rag/structure";
import { prisma } from "@/lib/db";
import { MIN_KNOWLEDGE_DOCS } from "@/lib/config/limits";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in to upload." }, { status: 401 });

  // Named preflight beats an SDK stack trace the user cannot act on.
  const needed = ["GEMINI_API_KEY", "PINECONE_API_KEY", "DATABASE_URL"];
  const missing = needed.filter((k) => !process.env[k]);
  if (missing.length) {
    return NextResponse.json(
      {
        error: `Missing environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(
          ", "
        )}. Add to .env.local, run "copy .env.local .env", then restart the dev server.`,
      },
      { status: 500 }
    );
  }

  const form = await req.formData();
  const projectId = String(form.get("projectId") ?? "");
  const kind = String(form.get("kind") ?? "knowledge");
  const files = form.getAll("files") as File[];

  if (!projectId) return NextResponse.json({ error: "Missing projectId." }, { status: 400 });
  if (!files.length) return NextResponse.json({ error: "Select at least one file." }, { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, userId } });
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

  const results = [];

  for (const file of files) {
   try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { text } = await extractText(buffer, file.name);

    if (text.length < 500) {
      results.push({ filename: file.name, error: "Too little extractable text. If this is a scanned PDF, run OCR first." });
      continue;
    }

    // Blob storage archives the original file. Nothing downstream reads it back
    // - text extraction, chunking and indexing all work from the buffer above -
    // so a missing token degrades to "no archive copy" rather than failing.
    let blobUrl = "";
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        // Private: uploaded theses are unpublished work and must not sit
        // behind a guessable public URL.
        const blob = await put(`${projectId}/${file.name}`, buffer, {
          access: "private",
          addRandomSuffix: true,
        });
        blobUrl = blob.url;
      } catch {
        // Archival is best-effort; indexing continues regardless.
      }
    }

    const doc = await prisma.document.create({
      data: { projectId, filename: file.name, blobUrl, kind },
    });

    if (kind === "sample") {
      const styleProfile = await extractStyle(text);
      await prisma.project.update({ where: { id: projectId }, data: { styleProfile } });
      results.push({ filename: file.name, styleProfile });
      continue;
    }

    if (kind === "structure") {
      const structureSpec = await extractStructure(text, file.name);
      await prisma.project.update({
        where: { id: projectId },
        data: { structureSpec: structureSpec as any },
      });
      results.push({ filename: file.name, structureSpec });
      continue;
    }

    const chunks = chunkDocument(text);
    const count = await indexChunks(projectId, doc.id, file.name, chunks);
    await prisma.document.update({ where: { id: doc.id }, data: { chunkCount: count } });

    results.push({ filename: file.name, chunks: count });
   } catch (err) {
     // One unreadable file should not discard the rest of the batch.
     results.push({ filename: file.name, error: humanizeError(err) });
   }
  }

  const knowledgeCount = await prisma.document.count({
    where: { projectId, kind: "knowledge" },
  });

  return NextResponse.json({
    results,
    knowledgeCount,
    minimum: MIN_KNOWLEDGE_DOCS,
    readyToGenerate: knowledgeCount >= MIN_KNOWLEDGE_DOCS && Boolean(project.styleProfile),
  });
}

/** Turns provider errors into something a user can act on. */
function humanizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/limit:\s*0/.test(raw)) {
    return "This Gemini model has no free-tier allowance (limit: 0). Google removed the Pro models from the free tier in April 2026. Remove GEMINI_USE_PRO from .env.local to use Flash, or enable billing at aistudio.google.com.";
  }
  if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(raw)) {
    return "Gemini rate limit reached. Wait a minute and try again. Free tier allows 15 requests per minute on Flash.";
  }
  if (/\b40[13]\b|API_KEY_INVALID|PERMISSION_DENIED/i.test(raw)) {
    return "Gemini rejected the API key. Check GEMINI_API_KEY in .env.local.";
  }
  if (/PineconeConfigurationError|Pinecone/i.test(raw)) {
    return "Pinecone request failed. Confirm the index is 768 dimensions with cosine metric.";
  }
  if (/dimension/i.test(raw)) {
    return "Vector dimension mismatch. The Pinecone index must be 768 dimensions.";
  }
  if (/Unsupported file type/i.test(raw)) return raw;

  return raw.slice(0, 200);
}
