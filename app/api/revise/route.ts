import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { generate } from "@/lib/gemini/client";
import { retrieve, asContextBlock } from "@/lib/rag/store";

/**
 * Revision chat.
 *
 * The user types an instruction ("make chapter 2 more critical of GM crops",
 * "shorten the methodology", "add a counter-argument about cost") and the AI
 * rewrites ONE chapter against that instruction and the project's own corpus.
 *
 * One chapter per request is deliberate: on the free Gemini tier a whole-thesis
 * revision would exhaust the 20/day quota in a single edit. Per-chapter keeps
 * each edit to a couple of requests, so the quota stretches across many edits.
 *
 * Citation integrity is preserved: the model is told it may only use handles
 * that already appear in the chapter, and the corpus is supplied so it can
 * ground any new claim it introduces. It may not invent new sources.
 */
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in." }, { status: 401 });

  const missing = ["GEMINI_API_KEY", "PINECONE_API_KEY", "DATABASE_URL"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    return NextResponse.json(
      { error: `Missing environment variable(s): ${missing.join(", ")}.` },
      { status: 500 }
    );
  }

  const { projectId, chapterOrder, instruction } = (await req.json()) as {
    projectId: string;
    chapterOrder: number;
    instruction: string;
  };

  if (!instruction || instruction.trim().length < 3) {
    return NextResponse.json(
      { error: "Tell me what to change, e.g. 'make this chapter more critical'." },
      { status: 400 }
    );
  }

  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true, topic: true, questions: true },
  });
  if (!project)
    return NextResponse.json({ error: "Project not found." }, { status: 404 });

  const chapter = await prisma.chapter.findUnique({
    where: { projectId_order: { projectId, order: chapterOrder } },
  });
  if (!chapter?.humanized) {
    return NextResponse.json(
      { error: "That chapter hasn't been generated yet." },
      { status: 400 }
    );
  }

  // Pull fresh corpus context so a requested new argument can be grounded.
  const corpus = await retrieve(
    projectId,
    `${project.topic}\n${instruction}`,
    10
  );

  // Which citation handles already exist in this chapter - the only ones allowed.
  const allowedHandles = [
    ...new Set((chapter.humanized.match(/\[[CW]\d+\]/g) ?? [])),
  ];

  let revised: string;
  try {
    const { text } = await generate(
      `Revise this thesis chapter according to the instruction. Change only what
the instruction asks; leave the rest intact.

INSTRUCTION:
${instruction}

RESEARCH QUESTIONS (the chapter must still answer these):
${project.questions}

CITATION RULES:
- You may use ONLY these citation handles, which already appear in the chapter:
  ${allowedHandles.join(", ") || "(none)"}
- Do not invent new handles or new sources.
- Every factual claim keeps or carries one of the allowed handles. If the
  instruction asks for a claim nothing supports, mark it [SYNTHESIS] rather
  than attaching a handle that doesn't back it.

SUPPORTING PASSAGES (for grounding any new argument):
${asContextBlock(corpus)}

CURRENT CHAPTER:
${chapter.humanized}

Return the full revised chapter in Markdown. No commentary before or after.`,
      { role: "writing", temperature: 0.5, maxOutputTokens: 8192 }
    );
    revised = text.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Revision failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  if (!revised) {
    return NextResponse.json(
      { error: "The model returned nothing. Try rephrasing the instruction." },
      { status: 502 }
    );
  }

  // Guard: a revision that drops citations has lost grounding - keep the original.
  const before = (chapter.humanized.match(/\[[CW]\d+\]/g) ?? []).length;
  const after = (revised.match(/\[[CW]\d+\]/g) ?? []).length;
  if (after < before * 0.5) {
    return NextResponse.json(
      {
        error:
          "That revision would have stripped most of the chapter's citations, so I kept the original. Try a narrower instruction.",
      },
      { status: 409 }
    );
  }

  await prisma.chapter.update({
    where: { projectId_order: { projectId, order: chapterOrder } },
    data: { humanized: revised },
  });

  return NextResponse.json({
    ok: true,
    chapterOrder,
    title: chapter.title,
    body: revised,
  });
}
