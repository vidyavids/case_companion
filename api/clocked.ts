import type { IncomingMessage, ServerResponse } from "node:http";
import { Clocked } from "clocked-sdk";

/**
 * Vercel serverless proxy for Clocked (also mounted in `vite dev` via
 * vite.config.ts). The browser never sees CLOCKED_API_KEY.
 *
 * POST /api/clocked { step, documents, ... } -> { ok, step, data, modelMs, credits, costUsd }
 * GET  /api/clocked -> { ok, hasKey } (key presence only, never the key)
 */

export interface CaseDoc {
  id: string;
  title: string;
  text: string;
}

type Step =
  | "protect"
  | "extract"
  | "decide"
  | "fill"
  | "verify"
  | "compare"
  | "rerank";

const EXTRACT_FIELDS: Record<string, string> = {
  lender: "Name of the lender bank",
  borrower: "Name of the borrower",
  guarantor: "Name of the personal guarantor",
  loan_amount: "Original loan principal amount, with currency",
  monthly_payment: "Monthly payment amount, with currency",
  balance_at_default: "Outstanding principal balance stated at default",
  amount_to_cure: "Total amount required to cure the default",
  loan_date: "Date of the loan agreement",
  default_date: "Date of the notice of default",
  cure_deadline: "Deadline to cure the default",
  court: "Name of the court hearing the case",
  case_number: "Court case number",
  next_hearing_datetime: "Date and time of the next hearing",
  bank_to_produce_by: "Deadline for the bank to produce documents",
  amount_claimed: "Total amount claimed in the complaint",
};

const DECIDE_QUESTIONS = {
  hearing_type: {
    type: "choice",
    criteria: {
      status_conference: "A routine status or scheduling conference.",
      motion_hearing: "A hearing to argue a filed motion.",
      trial: "A trial on the merits.",
      not_established: "The documents do not establish the hearing type.",
    },
  },
  continuance_likely: {
    type: "noul",
    instructions:
      "Is another continuance likely — i.e., do the documents suggest the court may continue the case again (prior continuance, settlement talks ordered, production still pending)?",
  },
  settlement_possible: {
    type: "noul",
    instructions:
      "Is settlement realistically in play — i.e., did the court direct settlement discussion, or do the documents show room to negotiate?",
  },
  prep_priority: {
    type: "score",
    criteria: [
      "1 - routine file review only",
      "2 - light preparation",
      "3 - standard hearing preparation",
      "4 - intensive preparation",
      "5 - urgent, drop-everything preparation",
    ],
  },
} as const;

const FILL_FIELDS = {
  caption: {
    type: "extract",
    description: "Case caption: the parties to the lawsuit",
    infer: false,
  },
  case_number: { type: "extract", description: "Court case number", infer: false },
  next_hearing: {
    type: "extract",
    description: "Next hearing date, time, and type",
    infer: false,
  },
  amounts_at_issue: {
    type: "extract",
    description: "Key dollar amounts: loan, balance, cure, amount claimed",
    list: true,
    infer: false,
  },
  bank_deadline: {
    type: "extract",
    description: "What the bank must produce and by when",
    infer: false,
  },
  hearing_type: {
    type: "choice",
    description: "Type of the upcoming hearing",
    options: ["status conference", "motion hearing", "trial"],
  },
  needs_settlement_report: {
    type: "yes_no",
    description: "Must the bank report on settlement discussions at the hearing?",
  },
  chronology: {
    type: "generate",
    description:
      "One short line per key event (loan, default, complaint, prior order, deadlines, next hearing), each starting with its date. Procedural facts only; no argument or legal advice.",
    format: "text",
    max_tokens: 300,
  },
  last_hearing_summary: {
    type: "generate",
    description:
      "Two or three short sentences summarizing what happened at the last hearing / in the prior court order. Procedural facts only; no argument or legal advice.",
    format: "text",
    max_tokens: 150,
  },
  where_it_stands: {
    type: "generate",
    description:
      "Two or three short sentences on where the case stands now: what is due, what is next. Procedural facts only; no argument or legal advice.",
    format: "text",
    max_tokens: 150,
  },
  bench_questions: {
    type: "generate",
    description:
      "Five questions a judge could ask based only on facts stated in the documents (the bank's November 10 production deadline, the settlement-discussion direction, the cure amount, the hearing type). Phrase each question using only stated facts. Numbered list, one question per line. No legal advice.",
    format: "text",
    max_tokens: 250,
  },
  talking_points: {
    type: "generate",
    description:
      "Three short factual status lines for the bank officer, each restating only facts stated in the documents: (1) the production deadline, (2) the payment-history facts, (3) the settlement-discussion direction. One fact per line, no argument and no legal advice.",
    format: "text",
    max_tokens: 200,
  },
} as const;

function combinedText(docs: CaseDoc[]): string {
  return docs.map((d) => `===== DOCUMENT: ${d.id} (${d.title}) =====\n${d.text}`).join("\n\n");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

interface StepBody {
  step: Step;
  documents?: CaseDoc[];
  /** verify: explicit brief lines to check as claims */
  claims?: string[];
  /** verify: full brief text as the answer */
  answer?: string;
  /** rerank: query + passages */
  query?: string;
  passages?: { id: string; title?: string; text: string }[];
  top_n?: number;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET") {
    send(res, 200, { ok: true, hasKey: Boolean(process.env.CLOCKED_API_KEY) });
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  let body: StepBody;
  try {
    body = JSON.parse(await readBody(req)) as StepBody;
  } catch {
    send(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  if (!process.env.CLOCKED_API_KEY) {
    send(res, 500, {
      ok: false,
      error: "CLOCKED_API_KEY is not set on the server. Add it to .env.local (local) or Vercel env vars.",
    });
    return;
  }

  const clocked = new Clocked();
  const docs = body.documents ?? [];
  const text = docs.length ? combinedText(docs) : "";

  try {
    switch (body.step) {
      case "protect": {
        if (!docs.length) return send(res, 400, { ok: false, error: "protect needs documents" });
        const out: { data: unknown; modelMs: unknown; credits: unknown; costUsd: unknown }[] = [];
        for (const d of docs) {
          const r = await clocked.pii({ text: d.text, anonymize: "mask" });
          out.push({ data: r.data, modelMs: r.modelMs, credits: r.credits, costUsd: r.costUsd });
        }
        return send(res, 200, { ok: true, step: body.step, results: out });
      }
      case "extract": {
        const r = await clocked.extract({ text, fields: EXTRACT_FIELDS });
        return send(res, 200, {
          ok: true, step: body.step, data: r.data,
          modelMs: r.modelMs, credits: r.credits, costUsd: r.costUsd,
        });
      }
      case "decide": {
        const r = await clocked.decide({ state: text, questions: DECIDE_QUESTIONS });
        return send(res, 200, {
          ok: true, step: body.step, data: r.data,
          modelMs: r.modelMs, credits: r.credits, costUsd: r.costUsd,
        });
      }
      case "fill": {
        const r = await clocked.fill({ text, fields: FILL_FIELDS });
        return send(res, 200, {
          ok: true, step: body.step, data: r.data,
          modelMs: r.modelMs, credits: r.credits, costUsd: r.costUsd,
        });
      }
      case "verify": {
        if (!docs.length || !body.answer)
          return send(res, 400, { ok: false, error: "verify needs documents and answer" });
        const r = await clocked.grounding({
          documents: docs.map((d) => ({ id: d.id, text: d.text })),
          answer: body.answer,
          claims: body.claims?.length ? body.claims.slice(0, 30) : undefined,
          evidence: "flagged",
        });
        return send(res, 200, {
          ok: true, step: body.step, data: r.data,
          modelMs: r.modelMs, credits: r.credits, costUsd: r.costUsd,
        });
      }
      case "compare": {
        // Latest court paper vs the earlier filing: the demo file holds one
        // order, so compare the complaint against the prior court order.
        const complaint = docs.find((d) => d.id === "complaint");
        const order = docs.find((d) => d.id === "prior-court-order");
        if (!complaint || !order)
          return send(res, 400, { ok: false, error: "compare needs complaint and prior-court-order documents" });
        const r = await clocked.compare({
          documents: [
            { id: complaint.id, text: complaint.text },
            { id: order.id, text: order.text },
          ],
          instructions:
            "Same case, same parties. Amounts from different stages (balance at default, cure amount, amount claimed) describe different things and are not contradictions unless stated for the same thing.",
        });
        return send(res, 200, {
          ok: true, step: body.step, data: r.data,
          modelMs: r.modelMs, credits: r.credits, costUsd: r.costUsd,
        });
      }
      case "rerank": {
        if (!body.query || !body.passages?.length)
          return send(res, 400, { ok: false, error: "rerank needs query and passages" });
        const r = await clocked.rerank({
          query: body.query,
          documents: body.passages.map((p) => ({ id: p.id, title: p.title, text: p.text })),
          top_n: body.top_n ?? body.passages.length,
        });
        return send(res, 200, {
          ok: true, step: body.step, data: r.data,
          modelMs: r.modelMs, credits: r.credits, costUsd: r.costUsd,
        });
      }
      default:
        return send(res, 400, { ok: false, error: `Unknown step: ${(body as StepBody).step}` });
    }
  } catch (err) {
    const e = err as { status?: number; error?: string; message?: string };
    send(res, 502, {
      ok: false,
      error: e?.error || e?.message || "Clocked request failed",
      status: e?.status ?? null,
    });
  }
}
