import { deepResearch } from "@/lib/gemini/research";
import { criticalPass } from "@/lib/critical/smart";
import { writeChapter, summariseChapter, CHAPTERS } from "@/lib/gemini/writer";
import { humanize } from "@/lib/humanizer/epic";
import { buildReferencePool, buildBibliography, findOrphanCitations } from "@/lib/citations/engine";
import type { StyleProfile } from "@/lib/rag/style";

export type Progress = { stage: string; chapter?: string; detail?: string };

export async function generateThesis(
  opts: {
    projectId: string;
    topic: string;
    objectives: string;
    questions: string;
    style: StyleProfile;
  },
  emit: (p: Progress) => void
) {
  const { projectId, topic, objectives, questions, style } = opts;

  emit({ stage: "research", detail: "Searching corpus and external literature" });
  const research = await deepResearch(projectId, topic, questions);

  const references = buildReferencePool(research.corpus, research.external);

  const chapters: { title: string; body: string }[] = [];
  const warnings: string[] = [];
  let priorSummaries = "";

  for (const chapter of CHAPTERS) {
    emit({ stage: "critique", chapter: chapter.title });
    const critique = await criticalPass(chapter.title, objectives, research);

    if (!critique.writeReady) {
      warnings.push(
        `${chapter.title}: evidence base is thin. ${critique.verdicts
          .filter((v) => !v.passed)
          .map((v) => `${v.criterion} — ${v.finding}`)
          .join("; ")}`
      );
    }

    emit({ stage: "writing", chapter: chapter.title });
    const draft = await writeChapter({
      chapter,
      topic,
      objectives,
      style,
      research,
      critique,
      references,
      priorSummaries,
    });

    emit({ stage: "humanizing", chapter: chapter.title });
    const finished = await humanize(draft, questions, (pass) =>
      emit({ stage: "humanizing", chapter: chapter.title, detail: pass })
    );

    const orphans = findOrphanCitations(finished, references);
    if (orphans.length) {
      warnings.push(
        `${chapter.title}: unmatched citation handles ${orphans.join(", ")} — verify before submission.`
      );
    }

    chapters.push({ title: chapter.title, body: finished });
    priorSummaries += `\n\n${chapter.title}: ${await summariseChapter(chapter.title, finished)}`;
  }

  emit({ stage: "references" });
  const bibliography = buildBibliography(references, style.citationStyle);

  const unverified = references.filter((r) => !r.verified).length;
  if (unverified) {
    warnings.push(
      `${unverified} reference(s) have incomplete metadata and are marked ⚠ VERIFY. Confirm each against the original source.`
    );
  }

  emit({ stage: "done" });

  return { chapters, bibliography, references, warnings };
}
