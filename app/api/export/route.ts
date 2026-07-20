import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import { prisma } from "@/lib/db";
import { buildBibliography } from "@/lib/citations/engine";
import type { StyleProfile } from "@/lib/rag/style";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in to export." }, { status: 401 });

  const { projectId, format } = await req.json();

  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    include: { chapters: { orderBy: { order: "asc" } }, references: true },
  });
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

  // Export whatever exists. A run stopped by a quota limit still leaves
  // finished chapters worth reading.
  const written = project.chapters.filter(
    (c: { humanized: string | null }) => c.humanized?.trim()
  );
  if (!written.length) {
    return NextResponse.json(
      { error: "No chapters have been generated yet." },
      { status: 400 }
    );
  }

  const style = (project.styleProfile as unknown as StyleProfile) ?? {
    citationStyle: "APA7" as const,
  };
  const bibliography = buildBibliography(project.references as any, style.citationStyle);

  if (format === "markdown") {
    const incomplete = written.length < project.chapters.length || project.status !== "complete";
    const md = [
      `# ${project.title}`,
      incomplete
        ? `\n\n> Draft in progress: ${written.length} chapter(s) generated. Verify all references before use.\n`
        : "",
      ...written.map((c: { title: string; humanized: string | null }) => `\n\n## ${c.title}\n\n${c.humanized ?? ""}`),
      `\n\n## References\n\n${bibliography}`,
    ].join("");
    return new NextResponse(md, {
      headers: {
        "Content-Type": "text/markdown",
        "Content-Disposition": `attachment; filename="${slug(project.title)}.md"`,
      },
    });
  }

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: project.title, heading: HeadingLevel.TITLE }),
          ...written.flatMap((c: { title: string; humanized: string | null }) => [
            new Paragraph({ text: c.title, heading: HeadingLevel.HEADING_1, pageBreakBefore: true }),
            ...toParagraphs(c.humanized ?? ""),
          ]),
          new Paragraph({ text: "References", heading: HeadingLevel.HEADING_1, pageBreakBefore: true }),
          ...bibliography.split("\n\n").map((r) => new Paragraph({ text: r, spacing: { after: 200 } })),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);

  // NextResponse takes a web BodyInit, which does not include Node's Buffer.
  // Wrapping the same memory in a Uint8Array satisfies the type without copying.
  const body = new Uint8Array(buffer);

  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${slug(project.title)}.docx"`,
    },
  });
}

function toParagraphs(markdown: string) {
  return markdown.split(/\n\s*\n/).filter(Boolean).map((block) => {
    const h = block.match(/^(#{2,4})\s+(.*)$/);
    if (h) {
      const level = [HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][h[1].length - 2];
      return new Paragraph({ text: h[2], heading: level });
    }
    return new Paragraph({
      children: [new TextRun(block.replace(/\*\*/g, ""))],
      spacing: { after: 200, line: 360 },
    });
  });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
