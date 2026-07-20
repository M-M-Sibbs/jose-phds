import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";

/** Admin is granted via Clerk publicMetadata.role, not a hardcoded list. */
async function isAdmin(userId: string) {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  return user.publicMetadata?.role === "admin";
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in." }, { status: 401 });
  if (!(await isAdmin(userId)))
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });

  const [projects, documents, chapters, references, unverified, recentLogs, byStatus] =
    await Promise.all([
      prisma.project.count(),
      prisma.document.count(),
      prisma.chapter.count(),
      prisma.reference.count(),
      prisma.reference.count({ where: { verified: false } }),
      prisma.researchLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { project: { select: { title: true, userId: true } } },
      }),
      prisma.project.groupBy({ by: ["status"], _count: true }),
    ]);

  const chunkTotal = await prisma.document.aggregate({ _sum: { chunkCount: true } });
  const tokenTotal = await prisma.researchLog.aggregate({ _sum: { tokens: true } });

  return NextResponse.json({
    totals: {
      projects,
      documents,
      chapters,
      references,
      unverifiedReferences: unverified,
      indexedChunks: chunkTotal._sum.chunkCount ?? 0,
      tokensUsed: tokenTotal._sum.tokens ?? 0,
    },
    projectsByStatus: Object.fromEntries(byStatus.map((s: { status: string; _count: number }) => [s.status, s._count])),
    recentLogs,
  });
}
