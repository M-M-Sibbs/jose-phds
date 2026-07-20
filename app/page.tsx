import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <p className="mono mb-4" style={{ color: "var(--ink-soft)" }}>
        Jose PhD&rsquo;s
      </p>
      <h1 className="display text-5xl leading-[1.1]">
        Draft the thesis your evidence can actually support.
      </h1>
      <p className="mt-6 max-w-xl text-lg" style={{ color: "var(--ink-soft)" }}>
        Upload a sample thesis to fix the house style, then ten or more sources
        to build the knowledge base. Every claim traces back to a passage you
        supplied or a source the search reached.
      </p>

      <Link
        href="/dashboard"
        className="display mt-10 inline-block rounded px-6 py-3 text-sm text-white"
        style={{ background: "var(--iron)" }}
      >
        Open dashboard
      </Link>

      <section className="mt-20 border-t pt-10" style={{ borderColor: "var(--rule)" }}>
        <h2 className="mono mb-6" style={{ color: "var(--ink-soft)" }}>
          How a chapter gets written
        </h2>
        <ol className="space-y-5">
          {[
            ["Retrieve", "Passages come from your corpus, scored and filtered."],
            ["Research", "Grounded search adds external literature with resolvable URLs."],
            ["Critique", "A SMART pass decides what the evidence can carry."],
            ["Draft", "Prose is written to the settled outline, in your institution's style."],
            ["Humanise", "Four passes: empathetic, purpose, impact, communicate."],
            ["Verify", "Weak metadata is flagged, never invented."],
          ].map(([title, body]) => (
            <li key={title} className="flex gap-5">
              <span className="mono shrink-0 pt-1" style={{ color: "var(--iron)", width: "5.5rem" }}>
                {title}
              </span>
              <span style={{ color: "var(--ink-soft)" }}>{body}</span>
            </li>
          ))}
        </ol>
      </section>

      <p className="mt-16 text-sm" style={{ color: "var(--ink-soft)" }}>
        Output is a draft. Verify every reference against the original source,
        and check your institution&rsquo;s policy on AI assistance.
      </p>
    </main>
  );
}
