import { useCallback, useEffect, useMemo, useState } from "react";
import { answerOf, fieldValue, isRefusal, keyStatus, runStep, splitChrono, splitLines, str, toPassages, type StepResult } from "./api";
import { CASE_META, DEMO_DOCS } from "./caseData";

type StepState = "idle" | "running" | "done" | "error";

interface StepInfo {
  key: string;
  label: string;
  endpoint: string;
  blurb: string;
}

const STEPS: StepInfo[] = [
  { key: "protect", label: "Protect", endpoint: "POST /clocked/pii", blurb: "Mask personal data in each document before anything else reads it." },
  { key: "extract", label: "Extract", endpoint: "POST /clocked/extract", blurb: "Copy 15 key facts verbatim, each with its source position." },
  { key: "decide", label: "Decide", endpoint: "POST /clocked/decide", blurb: "Hearing type, continuance outlook, settlement outlook, prep priority." },
  { key: "fill", label: "Fill", endpoint: "POST /clocked/fill", blurb: "Assemble the one-page brief record: facts, decisions, drafted lines." },
  { key: "verify", label: "Verify", endpoint: "POST /clocked/grounding", blurb: "Check every brief line against the file; unsupported lines go red." },
  { key: "compare", label: "Compare", endpoint: "POST /clocked/compare", blurb: "Complaint vs prior court order: duplicates, overlap, conflicts." },
  { key: "rerank", label: "Rerank", endpoint: "POST /clocked/rerank", blurb: "Rank the passages and bench questions that matter most." },
];

const EXTRACT_LABELS: [string, string][] = [
  ["lender", "Lender"],
  ["borrower", "Borrower"],
  ["guarantor", "Guarantor"],
  ["loan_amount", "Loan amount"],
  ["monthly_payment", "Monthly payment"],
  ["balance_at_default", "Balance at default"],
  ["amount_to_cure", "Amount to cure"],
  ["loan_date", "Loan date"],
  ["default_date", "Default date"],
  ["cure_deadline", "Cure deadline"],
  ["court", "Court"],
  ["case_number", "Case number"],
  ["next_hearing_datetime", "Next hearing"],
  ["bank_to_produce_by", "Bank to produce by"],
  ["amount_claimed", "Amount claimed"],
];

/** Rebuild the server's combined text so Extract offsets map back to docs. */
function docRanges(): { id: string; title: string; start: number; end: number }[] {
  const ranges: { id: string; title: string; start: number; end: number }[] = [];
  let pos = 0;
  DEMO_DOCS.forEach((d, i) => {
    const chunk = `===== DOCUMENT: ${d.id} (${d.title}) =====\n${d.text}`;
    ranges.push({ id: d.id, title: d.title, start: pos, end: pos + chunk.length });
    pos += chunk.length + (i < DEMO_DOCS.length - 1 ? 2 : 0);
  });
  return ranges;
}

function sourceOf(start: unknown, end: unknown, ranges: { id: string; title: string; start: number; end: number }[]): string {
  if (typeof start !== "number" || typeof end !== "number") return "source not reported";
  const hit = ranges.find((r) => start >= r.start && start < r.end);
  return hit ? hit.title : "source not reported";
}

interface ClaimVerdict {
  status: "supported" | "unverified";
  note: string;
}

function verdictsFor(verifyData: Record<string, unknown> | undefined): Map<string, ClaimVerdict> {
  const map = new Map<string, ClaimVerdict>();
  const claims = (verifyData?.claims as unknown[] | undefined) ?? [];
  for (const c of claims) {
    if (typeof c !== "object" || c === null) continue;
    const rec = c as Record<string, unknown>;
    const text = str(rec.claim).toLowerCase().replace(/\s+/g, " ").trim();
    if (!text) continue;
    const supported = Number(rec.supported ?? 0);
    const contradicted = Number(rec.contradicted ?? 0);
    const notStated = Number(rec.not_stated ?? 0);
    const ok = supported >= 0.5 && supported >= contradicted && supported >= notStated;
    map.set(text, {
      status: ok ? "supported" : "unverified",
      note: ok
        ? `supported (${Math.round(supported * 100)}%)`
        : contradicted >= 0.5
          ? `contradicted (${Math.round(contradicted * 100)}%)`
          : `not stated in file (${Math.round(notStated * 100)}%)`,
    });
  }
  return map;
}

function BriefLine({ text, verdict }: { text: string; verdict?: ClaimVerdict }) {
  const bad = verdict?.status === "unverified";
  return (
    <li className="flex items-start gap-2 py-0.5">
      <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
      <span className="flex-1">{text}</span>
      {verdict &&
        (bad ? (
          <span className="shrink-0 rounded bg-red-700 px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-white">
            UNVERIFIED
          </span>
        ) : (
          <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-800" title={verdict.note}>
            sourced
          </span>
        ))}
    </li>
  );
}

export default function App() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [results, setResults] = useState<Record<string, StepResult>>({});
  const [fatal, setFatal] = useState<string | null>(null);
  const [activeDoc, setActiveDoc] = useState(0);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    keyStatus()
      .then((s) => setHasKey(s.hasKey))
      .catch(() => setHasKey(false));
  }, []);

  const ranges = useMemo(() => docRanges(), []);
  const masked = useMemo(() => {
    const r = results.protect?.results;
    if (!r) return null;
    return r.map((one, i) => {
      const anon = str((one.data as Record<string, unknown>)?.anonymized_text);
      return anon || DEMO_DOCS[i].text;
    });
  }, [results.protect]);

  const verifyMap = useMemo(() => verdictsFor(results.verify?.data), [results.verify]);
  const verdictFor = useCallback(
    (line: string) => verifyMap.get(line.toLowerCase().replace(/\s+/g, " ").trim()),
    [verifyMap],
  );

  const loadDemoCase = useCallback(async () => {
    setRunning(true);
    setFatal(null);
    setResults({});
    setStates(Object.fromEntries(STEPS.map((s) => [s.key, "idle" as StepState])));
    const store: Record<string, StepResult> = {};
    const mark = (key: string, st: StepState) => setStates((p) => ({ ...p, [key]: st }));

    const docsPayload = DEMO_DOCS.map((d) => ({ id: d.id, title: d.title, text: d.text }));
    try {
      // 1. Protect — mask PII first
      mark("protect", "running");
      store.protect = await runStep("protect", { documents: docsPayload });
      if (!store.protect.ok) throw new Error(`Protect: ${store.protect.error}`);
      setResults({ ...store });
      mark("protect", "done");

      // 2. Extract
      mark("extract", "running");
      store.extract = await runStep("extract", { documents: docsPayload });
      if (!store.extract.ok) throw new Error(`Extract: ${store.extract.error}`);
      setResults({ ...store });
      mark("extract", "done");

      // 3. Decide
      mark("decide", "running");
      store.decide = await runStep("decide", { documents: docsPayload });
      if (!store.decide.ok) throw new Error(`Decide: ${store.decide.error}`);
      setResults({ ...store });
      mark("decide", "done");

      // 4. Fill
      mark("fill", "running");
      store.fill = await runStep("fill", { documents: docsPayload });
      if (!store.fill.ok) throw new Error(`Fill: ${store.fill.error}`);
      setResults({ ...store });
      mark("fill", "done");

      // 5. Verify — every brief line as an explicit claim
      const fillData = store.fill.data ?? {};
      const briefLines = [
        ...splitChrono(fieldValue(fillData, "chronology")),
        ...splitLines(fieldValue(fillData, "last_hearing_summary")),
        ...splitLines(fieldValue(fillData, "where_it_stands")),
        ...splitLines(fieldValue(fillData, "talking_points")),
      ];
      mark("verify", "running");
      store.verify = await runStep("verify", {
        documents: docsPayload,
        answer: briefLines.join("\n"),
        claims: briefLines,
      });
      if (!store.verify.ok) throw new Error(`Verify: ${store.verify.error}`);
      setResults({ ...store });
      mark("verify", "done");

      // 6. Compare
      mark("compare", "running");
      store.compare = await runStep("compare", { documents: docsPayload });
      if (!store.compare.ok) throw new Error(`Compare: ${store.compare.error}`);
      setResults({ ...store });
      mark("compare", "done");

      // 7. Rerank — passages, then bench questions
      mark("rerank", "running");
      const passages = toPassages(DEMO_DOCS);
      const rerankPassages = await runStep("rerank", {
        query: "What must the bank officer bring, produce, and be ready to answer at the November 12 status conference?",
        passages,
        top_n: 6,
      });
      if (!rerankPassages.ok) throw new Error(`Rerank: ${rerankPassages.error}`);
      const questions = splitLines(fieldValue(fillData, "bench_questions")).map((q, i) => ({
        id: `q${i + 1}`,
        title: "Candidate bench question",
        text: q,
      }));
      let rerankQuestions: StepResult | null = null;
      if (questions.length > 1) {
        rerankQuestions = await runStep("rerank", {
          query: "What is the judge most likely to ask the bank officer at the status conference?",
          passages: questions,
          top_n: questions.length,
        });
        if (!rerankQuestions.ok) throw new Error(`Rerank: ${rerankQuestions.error}`);
      }
      store.rerank = rerankPassages;
      if (rerankQuestions) store.rerankQuestions = rerankQuestions;
      setResults({ ...store });
      mark("rerank", "done");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFatal(message);
      setStates((p) => {
        const next = { ...p };
        for (const s of STEPS) if (next[s.key] === "running") next[s.key] = "error";
        return next;
      });
    } finally {
      setRunning(false);
    }
  }, []);

  const extractData = results.extract?.data;
  const decideData = results.decide?.data;
  const fillData = results.fill?.data;
  const done = states.fill === "done";

  const hearingType = answerOf(decideData, "hearing_type");
  const continuance = answerOf(decideData, "continuance_likely");
  const settlement = answerOf(decideData, "settlement_possible");
  const priority = answerOf(decideData, "prep_priority");

  const comparePair = useMemo(() => {
    const pairs = results.compare?.data?.pairs as
      | { a?: string; b?: string; relation?: string; related?: number; duplicates?: unknown[]; conflicts?: unknown[] }[]
      | undefined;
    return pairs?.[0];
  }, [results.compare]);

  const rankedPassages = useMemo(() => {
    const res = results.rerank?.data?.results as
      | { id?: string; action?: string; relevance_score?: number; document_score?: number }[]
      | undefined;
    if (!res) return [];
    const byId = new Map(toPassages(DEMO_DOCS).map((p) => [p.id, p]));
    return res.map((r) => ({ ...r, passage: r.id ? byId.get(r.id) : undefined }));
  }, [results.rerank]);

  const rankedQuestions = useMemo(() => {
    const res = results.rerankQuestions?.data?.results as
      | { id?: string; relevance_score?: number }[]
      | undefined;
    const questions = splitLines(fieldValue(fillData, "bench_questions"));
    if (!res) return questions.map((q) => ({ text: q, score: null as number | null }));
    const byId = new Map(questions.map((q, i) => [`q${i + 1}`, q]));
    return res.map((r) => ({
      text: (r.id && byId.get(r.id)) || "",
      score: typeof r.relevance_score === "number" ? r.relevance_score : null,
    }));
  }, [results.rerankQuestions, fillData]);

  const piiCounts = useMemo(() => {
    const list = results.protect?.results ?? [];
    return list.map((one) => {
      const counts = (one.data as Record<string, unknown>)?.counts as Record<string, number> | undefined;
      const total = counts ? Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0) : 0;
      return total;
    });
  }, [results.protect]);

  return (
    <div className="min-h-screen bg-stone-100 text-slate-900">
      {/* Header */}
      <header className="bg-slate-900 text-white">
        <div className="mx-auto max-w-6xl px-4 py-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">Clocked Build Challenge entry</p>
          <h1 className="mt-1 text-2xl font-bold sm:text-3xl">Case Companion</h1>
          <p className="mt-1 text-sm text-slate-300">
            {CASE_META.caption} · {CASE_META.court} · No. {CASE_META.caseNumber}
          </p>
          <p className="mt-1 text-sm font-medium text-slate-100">Next: {CASE_META.hearing}</p>
          <div className="mt-3 flex flex-col gap-1 text-xs sm:flex-row sm:gap-4">
            <span className="inline-flex w-fit items-center rounded bg-amber-500/15 px-2 py-1 font-semibold text-amber-300">
              Synthetic case only — no real borrower, bank, or case.
            </span>
            <span className="inline-flex w-fit items-center rounded bg-slate-700 px-2 py-1 font-semibold text-slate-200">
              Procedural preparation only — not legal advice.
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {/* Controls */}
        <section className="rounded-lg border border-stone-300 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              onClick={loadDemoCase}
              disabled={running}
              className="rounded-md bg-slate-900 px-5 py-2.5 text-sm font-bold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? "Building brief…" : "Load demo case"}
            </button>
            <p className="text-sm text-slate-600">
              One click loads the 4-file synthetic case and runs Protect → Extract → Decide → Fill → Verify → Compare →
              Rerank.
            </p>
            <span
              className={`ml-auto inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                hasKey === null
                  ? "bg-stone-200 text-slate-600"
                  : hasKey
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-red-100 text-red-800"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${hasKey ? "bg-emerald-600" : "bg-red-600"}`} />
              {hasKey === null ? "checking key…" : hasKey ? "Clocked key set" : "Clocked key missing"}
            </span>
          </div>
          {hasKey === false && (
            <p className="mt-2 text-sm text-red-800">
              Set <code className="rounded bg-stone-200 px-1 font-mono text-xs">CLOCKED_API_KEY</code> in{" "}
              <code className="rounded bg-stone-200 px-1 font-mono text-xs">.env.local</code> (local) or Vercel env vars,
              then reload. Nothing is mocked — every result below comes from Clocked.
            </p>
          )}
          {fatal && (
            <p className="mt-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
              {fatal}
            </p>
          )}
          <ol className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
            {STEPS.map((s) => {
              const st = states[s.key] ?? "idle";
              return (
                <li
                  key={s.key}
                  className={`rounded border px-2 py-1.5 text-center text-xs font-semibold ${
                    st === "done"
                      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                      : st === "running"
                        ? "border-amber-400 bg-amber-50 text-amber-800"
                        : st === "error"
                          ? "border-red-300 bg-red-50 text-red-800"
                          : "border-stone-200 bg-stone-50 text-slate-500"
                  }`}
                >
                  {st === "running" ? "… " : st === "done" ? "✓ " : ""}
                  {s.label}
                </li>
              );
            })}
          </ol>
        </section>

        <div className="mt-6 grid gap-6 lg:grid-cols-12">
          {/* Documents */}
          <section className="lg:col-span-5">
            <div className="overflow-hidden rounded-lg border border-stone-300 bg-white shadow-sm">
              <div className="border-b border-stone-200 px-4 py-3">
                <h2 className="text-base font-bold">Case file — 4 documents</h2>
                <p className="text-xs text-slate-600">
                  {masked ? "PII masked by Clocked Protect." : "Original text. Press “Load demo case” to mask PII."}
                </p>
              </div>
              <div className="flex flex-wrap gap-1 border-b border-stone-200 bg-stone-50 px-3 py-2" role="tablist">
                {DEMO_DOCS.map((d, i) => (
                  <button
                    key={d.id}
                    role="tab"
                    aria-selected={activeDoc === i}
                    onClick={() => setActiveDoc(i)}
                    className={`rounded px-2.5 py-1.5 text-xs font-semibold ${
                      activeDoc === i ? "bg-slate-900 text-white" : "bg-white text-slate-700 ring-1 ring-stone-200"
                    }`}
                  >
                    {i + 1}. {d.short}
                  </button>
                ))}
              </div>
              <div className="px-4 py-3">
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-700">
                    {DEMO_DOCS[activeDoc].title} · {DEMO_DOCS[activeDoc].date}
                  </span>
                  {masked && (
                    <span className="rounded bg-slate-900 px-1.5 py-0.5 font-semibold text-white">
                      {piiCounts[activeDoc] ?? 0} PII findings masked
                    </span>
                  )}
                </div>
                <div className="doc-text max-h-96 overflow-auto rounded border border-stone-200 bg-stone-50 p-3">
                  {(masked ?? DEMO_DOCS.map((d) => d.text))[activeDoc]}
                </div>
              </div>
            </div>

            {/* Key facts with sources */}
            {extractData && (
              <div className="mt-6 overflow-hidden rounded-lg border border-stone-300 bg-white shadow-sm">
                <div className="border-b border-stone-200 px-4 py-3">
                  <h2 className="text-base font-bold">Key facts — every value carries its source</h2>
                </div>
                <dl className="divide-y divide-stone-100 px-4 py-1 text-sm">
                  {EXTRACT_LABELS.map(([key, label]) => {
                    const fields = extractData.fields as Record<string, { value?: unknown; start?: unknown; end?: unknown }> | undefined;
                    const entry = fields?.[key];
                    const value = fieldValue(extractData, key);
                    const missing = !value;
                    return (
                      <div key={key} className="flex items-baseline justify-between gap-3 py-1.5">
                        <dt className="shrink-0 font-medium text-slate-600">{label}</dt>
                        <dd className="text-right">
                          {missing ? (
                            <span className="font-semibold text-amber-700">missing — not stated in file</span>
                          ) : (
                            <>
                              <span className="font-semibold">{value}</span>{" "}
                              <span className="text-xs text-slate-500">
                                ({sourceOf(entry?.start, entry?.end, ranges)})
                              </span>
                            </>
                          )}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
            )}

            {/* Decide readout */}
            {decideData && (
              <div className="mt-6 overflow-hidden rounded-lg border border-stone-300 bg-white shadow-sm">
                <div className="border-b border-stone-200 px-4 py-3">
                  <h2 className="text-base font-bold">Decide — hearing readout</h2>
                </div>
                <ul className="space-y-2 px-4 py-3 text-sm">
                  <li>
                    <span className="font-medium text-slate-600">Hearing type: </span>
                    <span className="font-bold">{str(hearingType.choice) || "—"}</span>
                  </li>
                  <li>
                    <span className="font-medium text-slate-600">Continuance likely: </span>
                    <span className="font-bold">
                      {typeof continuance.noul === "number"
                        ? `${continuance.noul >= 0.5 ? "yes" : "no"} (${Math.round(continuance.noul * 100)}%)`
                        : "—"}
                    </span>
                  </li>
                  <li>
                    <span className="font-medium text-slate-600">Settlement possible: </span>
                    <span className="font-bold">
                      {typeof settlement.noul === "number"
                        ? `${settlement.noul >= 0.5 ? "yes" : "no"} (${Math.round(settlement.noul * 100)}%)`
                        : "—"}
                    </span>
                  </li>
                  <li>
                    <span className="font-medium text-slate-600">Prep priority: </span>
                    <span className="font-bold">
                      {typeof priority.score === "number" ? `${(priority.score + 1).toFixed(1)} / 5` : "—"}
                    </span>
                  </li>
                </ul>
              </div>
            )}
          </section>

          {/* Brief */}
          <section className="lg:col-span-7">
            <div className="brief-sheet overflow-hidden rounded-lg border border-stone-300 bg-white shadow-sm">
              <div className="border-b-2 border-slate-900 px-5 py-4">
                <h2 className="text-lg font-bold">Hearing brief — one page</h2>
                <p className="text-sm">
                  {done ? fieldValue(fillData, "caption") || CASE_META.caption : CASE_META.caption}
                </p>
                <p className="text-sm text-slate-600">
                  {CASE_META.court} · No. {done ? fieldValue(fillData, "case_number") || CASE_META.caseNumber : CASE_META.caseNumber} ·{" "}
                  {done ? fieldValue(fillData, "next_hearing") || CASE_META.hearing : CASE_META.hearing}
                </p>
              </div>
              {!done ? (
                <p className="px-5 py-8 text-center text-slate-600">
                  {running ? "Reading the file and drafting the brief…" : "Press “Load demo case” to build the brief."}
                </p>
              ) : (
                <div className="space-y-5 px-5 py-4 text-[15px]">
                  <div>
                    <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-700">Chronology</h3>
                    <ul>
                      {splitChrono(fieldValue(fillData, "chronology")).map((l, i) => (
                        <BriefLine key={i} text={l} verdict={verdictFor(l)} />
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-700">Last-hearing summary</h3>
                    <ul>
                      {splitLines(fieldValue(fillData, "last_hearing_summary")).map((l, i) => (
                        <BriefLine key={i} text={l} verdict={verdictFor(l)} />
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-700">Where it stands</h3>
                    <ul>
                      {splitLines(fieldValue(fillData, "where_it_stands")).map((l, i) => (
                        <BriefLine key={i} text={l} verdict={verdictFor(l)} />
                      ))}
                    </ul>
                    <p className="mt-1 text-sm">
                      <span className="font-semibold">Bank deadline: </span>
                      {fieldValue(fillData, "bank_deadline") || "missing — not stated in file"}
                    </p>
                  </div>
                  <div>
                    <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-700">
                      Documents to carry
                    </h3>
                    <ul className="space-y-1 text-sm">
                      {DEMO_DOCS.map((d) => (
                        <li key={d.id} className="flex items-center justify-between gap-2">
                          <span>
                            {d.title} <span className="text-slate-500">({d.date})</span>
                          </span>
                          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-bold text-emerald-800">
                            IN FILE
                          </span>
                        </li>
                      ))}
                      <li className="flex items-center justify-between gap-2">
                        <span>
                          Payment history <span className="text-slate-500">(produce by Nov 10, 2026 — Prior Court Order)</span>
                        </span>
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-800">
                          MISSING
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>
                          Full loan file <span className="text-slate-500">(produce by Nov 10, 2026 — Prior Court Order)</span>
                        </span>
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-800">
                          MISSING
                        </span>
                      </li>
                    </ul>
                    <p className="mt-1 text-xs text-slate-500">
                      Missing items are flagged missing — never filled in by invention.
                    </p>
                  </div>
                  <div>
                    <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-700">
                      Likely questions from the bench
                    </h3>
                    <ol className="list-decimal space-y-0.5 pl-5">
                      {rankedQuestions.map((q, i) => (
                        <li key={i}>
                          {q.text}
                          {q.score !== null && (
                            <span className="text-xs text-slate-500"> ({Math.round(q.score * 100)}%)</span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div>
                    <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-700">Bank talking points</h3>
                    {isRefusal(fieldValue(fillData, "talking_points")) ? (
                      <p className="text-sm text-slate-600">
                        Clocked declined to draft this section — see the Decide readout and checklist above.
                      </p>
                    ) : (
                      <ul>
                        {splitLines(fieldValue(fillData, "talking_points")).map((l, i) => (
                          <BriefLine key={i} text={l} verdict={verdictFor(l)} />
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Compare */}
            {results.compare?.data && comparePair && (
              <div className="mt-6 overflow-hidden rounded-lg border border-stone-300 bg-white shadow-sm">
                <div className="border-b border-stone-200 px-4 py-3">
                  <h2 className="text-base font-bold">Compare — complaint vs prior court order</h2>
                </div>
                <div className="px-4 py-3 text-sm">
                  <p>
                    <span className="font-medium text-slate-600">Relation: </span>
                    <span className="font-bold">{str(comparePair.relation) || "—"}</span>
                    {typeof comparePair.related === "number" && (
                      <span className="text-slate-500"> ({Math.round(comparePair.related * 100)}% related)</span>
                    )}
                  </p>
                  <p className="mt-1">
                    <span className="font-medium text-slate-600">Duplicates: </span>
                    {comparePair.duplicates?.length ?? 0}
                    {" · "}
                    <span className="font-medium text-slate-600">Conflicts: </span>
                    {comparePair.conflicts?.length ?? 0}
                  </p>
                  {(comparePair.conflicts?.length ?? 0) > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer font-semibold text-amber-800">Conflict passages</summary>
                      <pre className="doc-text mt-1 max-h-48 overflow-auto rounded bg-stone-50 p-2">
                        {JSON.stringify(comparePair.conflicts, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            )}

            {/* Rerank */}
            {rankedPassages.length > 0 && (
              <div className="mt-6 overflow-hidden rounded-lg border border-stone-300 bg-white shadow-sm">
                <div className="border-b border-stone-200 px-4 py-3">
                  <h2 className="text-base font-bold">Rerank — passages to read first</h2>
                </div>
                <ol className="space-y-2 px-4 py-3 text-sm">
                  {rankedPassages.map((r, i) => (
                    <li key={i} className="rounded border border-stone-200 bg-stone-50 p-2.5">
                      <p className="text-xs font-semibold text-slate-600">
                        #{i + 1} · {r.passage?.title ?? r.id} · action: {str(r.action) || "—"}
                        {typeof r.relevance_score === "number" && ` · ${Math.round(r.relevance_score * 100)}%`}
                      </p>
                      <p className="mt-1 line-clamp-3">{r.passage?.text}</p>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </section>
        </div>

        {/* How Clocked was used */}
        <section className="mt-6 overflow-hidden rounded-lg border border-stone-300 bg-white shadow-sm">
          <div className="border-b border-stone-200 px-4 py-3">
            <h2 className="text-base font-bold">How Clocked was used</h2>
            <p className="text-xs text-slate-600">
              Every call goes browser → <code className="font-mono">/api/clocked</code> → Clocked. The API key lives
              server-side only.
            </p>
          </div>
          <ul className="divide-y divide-stone-100">
            {STEPS.map((s) => {
              const r = results[s.key];
              return (
                <li key={s.key} className="px-4 py-2.5 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="font-bold">{s.label}</span>
                    <code className="font-mono text-xs text-slate-500">{s.endpoint}</code>
                    {r?.ok && (
                      <span className="ml-auto text-xs text-slate-500">
                        {r.modelMs != null && `${r.modelMs} ms model time`}
                        {r.credits != null && ` · ${r.credits} credits`}
                        {r.costUsd != null && ` · $${Number(r.costUsd).toFixed(4)}`}
                      </span>
                    )}
                  </div>
                  <p className="text-slate-600">{s.blurb}</p>
                  {s.key === "protect" && r?.ok && (
                    <p className="text-xs text-slate-500">
                      Per-document:{" "}
                      {r.results?.map((one) => `${one.modelMs ?? "?"} ms`).join(" · ")}
                    </p>
                  )}
                  {r?.ok && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs font-semibold text-slate-600">
                        Raw {s.label} response
                      </summary>
                      <pre className="doc-text mt-1 max-h-64 overflow-auto rounded bg-stone-50 p-2">
                        {JSON.stringify(r.data ?? r.results?.map((x) => x.data), null, 2)}
                      </pre>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <footer className="mt-6 border-t border-stone-300 pt-4 text-center text-xs text-slate-500">
          <p className="font-semibold">Synthetic case only — no real borrower, bank, or case.</p>
          <p className="font-semibold">Procedural preparation only — not legal advice.</p>
          <p className="mt-1">Nothing submitted is stored. No database. Built for the Clocked Build Challenge.</p>
        </footer>
      </main>
    </div>
  );
}
