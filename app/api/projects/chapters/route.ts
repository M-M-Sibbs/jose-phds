import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in." }, { status: 401 });

  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "Missing projectId." }, { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, userId } });
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

  const rows = await prisma.chapter.findMany({
    where: { projectId },
    orderBy: { order: "asc" },
    select: { title: true, humanized: true },
  });

  return NextResponse.json({
    chapters: rows.map((r: { title: string; humanized: string | null }) => ({
      title: r.title,
      body: r.humanized ?? "",
    })),
  });
}
