export type { StyleProfile } from "@/lib/rag/style";
export type { Chunk } from "@/lib/rag/chunk";
export type { Retrieved } from "@/lib/rag/store";
export type { Reference } from "@/lib/citations/engine";
export type { CriticalReport, SmartVerdict } from "@/lib/critical/smart";
export type { ResearchBrief, ResearchResult } from "@/lib/gemini/research";
export type { Progress } from "@/lib/gemini/orchestrator";
export type { PassName } from "@/lib/humanizer/epic";

export type ProjectStatus = "draft" | "generating" | "complete" | "failed";
