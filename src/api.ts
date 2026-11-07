import type { CaseDoc } from "./caseData";

export interface DocPayload {
  id: string;
  title: string;
  text: string;
}

export interface StepResult {
  ok: boolean;
  step?: string;
  data?: Record<string, unknown>;
  results?: { data: Record<string, unknown>; modelMs: number | null; credits: number | null; costUsd: number | null }[];
  modelMs?: number | null;
  credits?: number | null;
  costUsd?: number | null;
  error?: string;
  status?: number | null;
}

export interface RerankPassage {
  id: string;
  title?: string;
  text: string;
}

export async function keyStatus(): Promise<{ ok: boolean; hasKey: boolean }> {
  const res = await fetch("/api/clocked");
  if (!res.ok) return { ok: false, hasKey: false };
  return (await res.json()) as { ok: boolean; hasKey: boolean };
}

export async function runStep(
  step: string,
  payload: {
    documents?: DocPayload[];
    claims?: string[];
    answer?: string;
    query?: string;
    passages?: RerankPassage[];
    top_n?: number;
  },
): Promise<StepResult> {
  const res = await fetch("/api/clocked", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step, ...payload }),
  });
  const json = (await res.json()) as StepResult;
  if (!res.ok && json.ok !== false) {
    return { ok: false, error: `Server error ${res.status}` };
  }
  return json;
}

/** Split generated text into clean lines (drops blanks, keeps numbering). */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*•]\s+/, ""))
    .filter((l) => l.length > 0);
}

/** Split a chronology into one event per line (newlines or semicolons). */
export function splitChrono(text: string): string[] {
  return text
    .split(/\r?\n|;\s*/)
    .map((l) => l.trim().replace(/^[-*•]\s+/, ""))
    .filter((l) => l.length > 0);
}

/** Strip a leading "1." / "1)" list number so ranked items carry one number only. */
export function stripLeadingNumber(text: string): string {
  return text.replace(/^\d+[.)]\s+/, "");
}

/** Detect a model refusal so the UI can say so instead of printing it. */
export function isRefusal(text: string): boolean {
  return /^\s*I (am sorry|'m sorry|cannot|can't|can not|am unable|am not able|must decline)/i.test(text);
}

/** Split a document into paragraph passages for rerank. */
export function toPassages(docs: CaseDoc[]): RerankPassage[] {
  const out: RerankPassage[] = [];
  for (const d of docs) {
    const paras = d.text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter((p) => p.length > 60 && !p.startsWith("SYNTHETIC DOCUMENT"));
    paras.forEach((p, i) => out.push({ id: `${d.id}#p${i + 1}`, title: d.title, text: p }));
  }
  return out;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Read data.fields[name].value from an Extract/Fill response. */
export function fieldValue(data: Record<string, unknown> | undefined, name: string): string {
  if (!data) return "";
  const fields = data.fields as Record<string, { value?: unknown } | undefined> | undefined;
  const entry = fields?.[name];
  const value = entry?.value;
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "object" && v !== null && "value" in v ? str((v as { value: unknown }).value) : str(v)))
      .filter(Boolean)
      .join("; ");
  }
  return str(value);
}

/** Read data.answers[name] from a Decide response. */
export function answerOf(data: Record<string, unknown> | undefined, name: string): Record<string, unknown> {
  if (!data) return {};
  const answers = data.answers as Record<string, Record<string, unknown>> | undefined;
  return answers?.[name] ?? {};
}
