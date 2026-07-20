export type Chunk = {
  text: string;
  index: number;
  section: string | null;
};

const HEADING = /^(?:chapter\s+\d+|\d+(?:\.\d+)*\s+[A-Z]|[A-Z][A-Z\s]{6,})\s*$/;

/**
 * Splits on paragraph boundaries and packs into ~1200-char windows with
 * overlap, so a retrieved chunk almost never cuts an argument in half.
 * Tracks the nearest preceding heading so citations can say where in the
 * source document a passage came from.
 */
export function chunkDocument(
  text: string,
  { size = 1200, overlap = 200 } = {}
): Chunk[] {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  const chunks: Chunk[] = [];
  let buffer = "";
  let section: string | null = null;

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed.length < 80) return;
    chunks.push({ text: trimmed, index: chunks.length, section });
    buffer = trimmed.slice(-overlap);
  };

  for (const para of paragraphs) {
    const line = para.trim();
    if (line.length < 90 && HEADING.test(line)) {
      flush();
      section = line;
      buffer = "";
      continue;
    }
    if (buffer.length + line.length > size) flush();
    buffer += (buffer ? "\n\n" : "") + line;
  }
  flush();

  return chunks;
}
