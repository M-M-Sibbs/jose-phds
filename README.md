# Jose PhD's

AI research and drafting platform for doctoral theses. RAG over your own
document corpus, grounded external literature search, a SMART critical pass
before any prose is written, and a four-stage EPIC humanising pipeline.

## About the API key

**The Gemini key does not go in the GitHub repository — not even a private one.**

A key committed to git is exposed to everyone with repo access, every CI runner
that clones it, anyone the repo is later shared with, and it stays in history
after deletion. Private repos get made public by accident, and scrapers watch
for exactly this. Once a Gemini key leaks, the billing is yours.

Set it in **Vercel → Settings → Environment Variables** instead. `lib/gemini/client.ts`
reads `process.env.GEMINI_API_KEY` at runtime, so the value never enters the
bundle or the repo. For local work put it in `.env.local`, which `.gitignore`
already excludes.

Also restrict the key in Google Cloud Console to the Generative Language API,
and rotate it on a schedule.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in locally; never commit
npx prisma db push
npm run dev
```

Create a Pinecone index with **768 dimensions**, **cosine** metric, to match
`text-embedding-004`.

## Deploy

```bash
vercel
vercel env add GEMINI_API_KEY
vercel env add PINECONE_API_KEY
vercel env add DATABASE_URL
vercel env add CLERK_SECRET_KEY
vercel --prod
```

Generation runs long. On Vercel this needs a Pro plan for the 800s
`maxDuration` in `app/api/generate/route.ts`; on Hobby, lower it and generate
one chapter per request.

## How it works

| Stage | Module | What it does |
|---|---|---|
| Ingest | `lib/parse`, `lib/rag/chunk.ts` | Extracts text, splits on paragraph boundaries with overlap, tracks headings |
| Style | `lib/rag/style.ts` | Reads the sample thesis and reports that institution's conventions |
| Index | `lib/rag/store.ts` | Embeds and upserts into a per-project Pinecone namespace |
| Research | `lib/gemini/research.ts` | Grounded web search fused with corpus retrieval; every finding carries a source handle |
| Critique | `lib/critical/smart.ts` | SMART pass; decides what can be argued before deciding how to say it |
| Draft | `lib/gemini/writer.ts` | Writes to the settled outline, in the learned style |
| Humanise | `lib/humanizer/epic.ts` | Empathetic → Purpose → Impact → Communicate |
| Cite | `lib/citations/engine.ts` | APA 7, Harvard, IEEE, Chicago; flags unverified metadata |

## Citation integrity

References come only from your uploaded corpus or from grounded search results
with resolvable URLs. Nothing is synthesised. Entries with incomplete metadata
are marked `⚠ VERIFY` and listed in the warnings panel; citation handles that
appear in the draft with no matching source are reported as orphans rather than
quietly matched to something plausible.

Each humanising pass is checked for citation loss — a pass that drops handles
is discarded and the prior draft kept.

The output is a **draft**. Verify every reference against the original source
before submission, and check your institution's rules on AI assistance.
