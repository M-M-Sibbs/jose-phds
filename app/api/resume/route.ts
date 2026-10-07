import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";

/**
 * Auto-resume.
 *
 * Finds this user's projects that are mid-generation (status "generating" or
 * "failed") and reports what can be continued. The actual chapter work still
 * runs through /api/generate one step at a time; this endpoint is the trigger
 * that a scheduler (Vercel Cron) OR a "Resume all" button can call to kick
 * stalled projects back into motion after the daily Gemini quota resets.
 *
 * It deliberately does NOT loop through generation itself: that would spend the
 * whole daily quota in one unattended burst and risk a serverless timeout. It
 * returns the list of resumable projects; the client drives each one.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in." }, { status: 401 });

  const stalled = await prisma.project.findMany({
    where: { userId, status: { in: ["generating", "failed"] } },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      status: true,
      updatedAt: true,
      _count: { select: { chapters: true } },
    },
  });

  return NextResponse.json({
    resumable: stalled.map((p: typeof stalled[number]) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      chaptersSoFar: p._count.chapters,
      updatedAt: p.updatedAt,
    })),
    count: stalled.length,
  });
}

/**
 * POST marks a stalled project ready to continue and hands back the step the
 * client should resume from. The client then calls /api/generate with that
 * step, exactly as the Resume button already does — so one code path drives
 * both manual and scheduled resumes.
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in." }, { status: 401 });

  const { projectId } = await req.json();

  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true, status: true, researchCache: true },
  });
  if (!project)
    return NextResponse.json({ error: "Project not found." }, { status: 404 });

  if (project.status === "complete") {
    return NextResponse.json({ error: "This project is already complete." }, { status: 400 });
  }

  // Re-open it; the client resumes stepping via /api/generate.
  await prisma.project.update({
    where: { id: projectId },
    data: { status: "generating" },
  });

  // If research never finished, resume there; otherwise continue chapters.
  // The generate route treats a null `step` as "start at research", and its
  // own progress rows tell it where chapter work left off.
  const resumeStep = project.researchCache ? null : { kind: "research" };

  return NextResponse.json({
    ok: true,
    projectId,
    resumeStep,
    note: "Call /api/generate with this step to continue. Progress is saved after every step.",
  });
}
