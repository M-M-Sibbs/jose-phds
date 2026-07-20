import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { dropProject } from "@/lib/rag/store";

const CreateProject = z.object({
  title: z.string().min(3, "Give the project a title of at least 3 characters."),
  topic: z.string().min(10, "Describe the research topic in at least 10 characters."),
  objectives: z.string().min(10, "List the research objectives."),
  questions: z.string().min(10, "List the research questions."),
});

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in to view projects." }, { status: 401 });

  const projects = await prisma.project.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { documents: true, chapters: true, references: true } },
    },
  });

  return NextResponse.json({ projects });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in to create a project." }, { status: 401 });

  const parsed = CreateProject.safeParse(await req.json());
  if (!parsed.success) {
    // Report every failing field at once, named, so the user does not fix one
    // and immediately hit the next.
    return NextResponse.json(
      {
        error: parsed.error.issues
          .map((i) => `${String(i.path[0] ?? "field")}: ${i.message}`)
          .join(" | "),
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [String(i.path[0] ?? "field"), i.message])
        ),
      },
      { status: 400 }
    );
  }

  const project = await prisma.project.create({
    data: { userId, ...parsed.data },
  });

  return NextResponse.json({ project }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in to delete." }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing project id." }, { status: 400 });

  const project = await prisma.project.findFirst({ where: { id, userId } });
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

  // Clear the vector namespace before the row goes, or the embeddings orphan.
  await dropProject(id).catch(() => {});
  await prisma.project.delete({ where: { id } });

  return NextResponse.json({ deleted: id });
}
