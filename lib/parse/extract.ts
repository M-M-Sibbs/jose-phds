import mammoth from "mammoth";

export type ParsedDoc = { text: string; pages?: number };

export async function extractText(
  buffer: Buffer,
  filename: string
): Promise<ParsedDoc> {
  const ext = filename.toLowerCase().split(".").pop();

  if (ext === "pdf") {
    // Lazy require keeps pdf-parse out of the edge bundle.
    const pdfParse = (await import("pdf-parse")).default;
    const out = await pdfParse(buffer);
    return { text: normalize(out.text), pages: out.numpages };
  }

  if (ext === "docx") {
    const out = await mammoth.extractRawText({ buffer });
    return { text: normalize(out.value) };
  }

  if (ext === "txt" || ext === "md") {
    return { text: normalize(buffer.toString("utf8")) };
  }

  throw new Error(`Unsupported file type: .${ext}. Upload PDF, DOCX, or TXT.`);
}

function normalize(raw: string) {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/-\n(?=[a-z])/g, "") // rejoin words broken across lines
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
