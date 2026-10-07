import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { deepResearch } from "@/lib/gemini/research";
import { criticalPass } from "@/lib/critical/smart";
import { writeChapter, summariseChapter, CHAPTERS } from "@/lib/gemini/writer";
import { runPass, activePasses, type PassName } from "@/lib/humanizer/epic";
import { buildReferencePool, findOrphanCitations } from "@/lib/citations/engine";
import type { StyleProfile } from "@/lib/rag/style";
import { MIN_KNOWLEDGE_DOCS } from "@/lib/config/limits";
import { resolveOutline, type StructureSpec } from "@/lib/rag/structure";

/**
 * One step per request.
 *
 * A full thesis takes 15-40 minutes of model calls, which exceeds every
 * serverless execution limit (60s on Vercel Hobby, 800s on Pro). Splitting the
 * work into steps that each finish well under a minute means the same pipeline
 * runs anywhere, survives a dropped connection, and resumes where it stopped.
 *
 * The client calls this repeatedly, following the `next` field until it is null.
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type Step =
  | { kind: "research" }
  | { kind: "critique"; chapter: number }
  | { kind: "draft"; chapter: number }
  | { kind: "humanize"; chapter: number; pass: PassName }
  | { kind: "done" };

const PASSES: PassName[] = activePasses();

const countHandles = (t: string) => (t.match(/\[[CW]\d+\]/g) ?? []).length;

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in to generate." }, { status: 401 });

  const missing = ["GEMINI_API_KEY", "PINECONE_API_KEY", "DATABASE_URL"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    return NextResponse.json(
      {
        error: `Missing environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(
          ", "
        )}. Add to .env.local and restart the dev server.`,
      },
      { status: 500 }
    );
  }

  const { projectId, step } = (await req.json()) as { projectId: string; step?: Step };

  const project = await prisma.project.findFirst({ where: { id: projectId, userId } });
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  if (!project.styleProfile)
    return NextResponse.json({ error: "Upload a sample thesis first." }, { status: 400 });

  const knowledgeCount = await prisma.document.count({
    where: { projectId, kind: "knowledge" },
  });
  if (knowledgeCount < MIN_KNOWLEDGE_DOCS)
    return NextResponse.json(
      { error: `Upload at least ${MIN_KNOWLEDGE_DOCS} knowledge documents. You have ${knowledgeCount}.` },
      { status: 400 }
    );

  const style = project.styleProfile as unknown as StyleProfile;
  // Institution-supplied structure overrides the built-in outline.
  const outline = resolveOutline(
    CHAPTERS,
    (project.structureSpec as unknown as StructureSpec) ?? null
  );
  const current: Step = step ?? { kind: "research" };

  try {
    if (current.kind === "research") {
      const research = await deepResearch(projectId, project.topic, project.questions);
      const references = buildReferencePool(research.corpus, research.external);

      await prisma.$transaction([
        prisma.reference.deleteMany({ where: { projectId } }),
        prisma.reference.createMany({
          // Fields are mapped explicitly rather than spread: a spread passes
          // through any property added to the Reference type later, and Prisma
          // rejects the whole transaction on an unknown argument.
          data: references.map((r) => ({
            projectId,
            handle: r.handle,
            authors: r.authors,
            year: r.year,
            title: r.title,
            container: r.container,
            uri: r.uri,
            origin: r.origin,
            verified: r.verified,
          })),
        }),
        prisma.chapter.deleteMany({ where: { projectId } }),
        prisma.project.update({
          where: { id: projectId },
          data: { status: "generating", researchCache: research as any },
        }),
      ]);

      return NextResponse.json({
        label: `${research.corpus.length} passages, ${research.external.length} external sources`,
        warning: research.searchNote,
        next: { kind: "critique", chapter: 0 } as Step,
        progress: 0.04,
      });
    }

    if (current.kind === "critique") {
      const research = project.researchCache as any;
      if (!research) return NextResponse.json({ error: "Run research first." }, { status: 400 });

      const chapter = outline[current.chapter];
      const critique = await criticalPass(chapter.title, project.objectives, research);

      await prisma.chapter.upsert({
        where: { projectId_order: { projectId, order: current.chapter } },
        create: {
          projectId,
          order: current.chapter,
          title: chapter.title,
          critique: critique as any,
        },
        update: { critique: critique as any },
      });

      return NextResponse.json({
        label: `${chapter.title}: ${critique.writeReady ? "evidence sufficient" : "evidence thin"}`,
        warning: critique.writeReady
          ? null
          : `${chapter.title}: ${critique.verdicts
              .filter((v) => !v.passed)
              .map((v) => `${v.criterion} — ${v.finding}`)
              .join("; ")}`,
        next: { kind: "draft", chapter: current.chapter } as Step,
        progress: 0.04 + current.chapter * 0.16,
      });
    }

    if (current.kind === "draft") {
      const research = project.researchCache as any;
      const chapter = outline[current.chapter];

      const [row, references, priorRows] = await Promise.all([
        prisma.chapter.findUnique({
          where: { projectId_order: { projectId, order: current.chapter } },
        }),
        prisma.reference.findMany({ where: { projectId } }),
        prisma.chapter.findMany({
          where: { projectId, order: { lt: current.chapter } },
          orderBy: { order: "asc" },
          select: { title: true, summary: true },
        }),
      ]);

      const draft = await writeChapter({
        chapter,
        topic: project.topic,
        objectives: project.objectives,
        style,
        research,
        critique: row?.critique as any,
        references: references as any,
        priorSummaries: priorRows
          .map((p: { title: string; summary: string | null }) => `${p.title}: ${p.summary ?? ""}`)
          .join("\n\n"),
      });

      await prisma.chapter.update({
        where: { projectId_order: { projectId, order: current.chapter } },
        data: { draft, humanized: draft },
      });

      return NextResponse.json({
        label: `${chapter.title} drafted`,
        next: { kind: "humanize", chapter: current.chapter, pass: "empathetic" } as Step,
        progress: 0.04 + current.chapter * 0.16 + 0.06,
      });
    }

    if (current.kind === "humanize") {
      const chapter = outline[current.chapter];
      const row = await prisma.chapter.findUnique({
        where: { projectId_order: { projectId, order: current.chapter } },
      });
      if (!row?.humanized)
        return NextResponse.json({ error: "Draft the chapter first." }, { status: 400 });

      const before = row.humanized;
      const after = await runPass(before, current.pass, project.questions);

      // A pass that drops citations has failed its invariant; keep the prior text.
      const kept = countHandles(after) >= countHandles(before) ? after : before;

      const passIndex = PASSES.indexOf(current.pass);
      const isLastPass = passIndex === PASSES.length - 1;
      const isLastChapter = current.chapter === outline.length - 1;

      const data: Record<string, unknown> = { humanized: kept };
      let warning: string | null = null;

      if (isLastPass) {
        const references = await prisma.reference.findMany({ where: { projectId } });
        const orphans = findOrphanCitations(kept, references as any);
        if (orphans.length)
          warning = `${chapter.title}: unmatched citation handles ${orphans.join(
            ", "
          )} — verify before submission.`;
        data.summary = await summariseChapter(chapter.title, kept);
      }

      await prisma.chapter.update({
        where: { projectId_order: { projectId, order: current.chapter } },
        data,
      });

      const next: Step = !isLastPass
        ? { kind: "humanize", chapter: current.chapter, pass: PASSES[passIndex + 1] }
        : !isLastChapter
          ? { kind: "critique", chapter: current.chapter + 1 }
          : { kind: "done" };

      return NextResponse.json({
        label: `${chapter.title}: ${current.pass} pass`,
        warning,
        next,
        progress: 0.04 + current.chapter * 0.16 + 0.06 + (passIndex + 1) * 0.02,
      });
    }

    // done
    await prisma.project.update({ where: { id: projectId }, data: { status: "complete" } });
    const unverified = await prisma.reference.count({ where: { projectId, verified: false } });

    return NextResponse.json({
      label: "Complete",
      warning: unverified
        ? `${unverified} reference(s) have incomplete metadata and are marked VERIFY. Confirm each against the original source.`
        : null,
      next: null,
      progress: 1,
    });
  } catch (err) {
    // Log the full error server-side: the JSON response only carries a message,
    // which hides the stack when a step fails deep in the pipeline.
    console.error(`\n[generate] step "${current.kind}" failed:`, err, "\n");

    const message = err instanceof Error ? err.message : "Generation step failed.";
    await prisma.project
      .update({ where: { id: projectId }, data: { status: "failed" } })
      .catch(() => {});
    // Returning the step lets the client retry this unit of work rather than
    // restarting the whole thesis.
    return NextResponse.json({ error: message, retryStep: current }, { status: 500 });
  }
}
