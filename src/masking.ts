/**
 * Display-only personal-name masking.
 *
 * Protect already identifies person entities per document; this module reuses
 * those findings (plus bare surnames) to mask the same names on every other
 * UI surface, with Protect's own token format: asterisks matched to the
 * replaced length. Companies, amounts, dates, case numbers, and roles are
 * never touched. API payloads and Verify/Rerank matching stay unmasked —
 * masking applies only at render time.
 */

/** Collect person-entity values from Protect step results. */
export function collectPersonNames(results: { data?: unknown }[] | undefined): string[] {
  const names = new Set<string>();
  for (const r of results ?? []) {
    const data = r?.data as { entities?: unknown } | undefined;
    const entities = Array.isArray(data?.entities) ? data.entities : [];
    for (const e of entities) {
      const rec = e as { type?: unknown; value?: unknown };
      if (rec?.type === "person" && typeof rec.value === "string" && rec.value.trim()) {
        names.add(rec.value.trim());
      }
    }
  }
  // Longest first so "Mr. Whitfield" wins over any shorter overlap.
  return [...names].sort((a, b) => b.length - a.length);
}

/** Bare surnames (last token) of multi-word person names, for whole-word masking. */
export function collectSurnames(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const parts = n.split(/\s+/).filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    if (parts.length >= 2 && /^[A-Za-z][A-Za-z'.-]*$/.test(last)) {
      out.add(last);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mask every person name (full, then bare surname) with length-matched asterisks. */
export function maskText(text: string, names: string[]): string {
  if (!text || names.length === 0) return text;
  let out = text;
  for (const n of names) {
    if (n && out.includes(n)) {
      out = out.split(n).join("*".repeat(n.length));
    }
  }
  for (const s of collectSurnames(names)) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(s)}\\b`, "g"), "*".repeat(s.length));
  }
  return out;
}

/** Display token for a masked name. Roles and labels around it are kept. */
export const MASKED_LABEL = "[name masked]";

/** Translate Protect-style asterisk runs (3+) into the display token. */
export function translateMaskRuns(text: string): string {
  if (!text) return text;
  return text.replace(/\*{3,}/g, MASKED_LABEL);
}

/**
 * Final display text: mask any leaked full name first (fallback for text
 * Protect never saw), then translate every mask run into the display token.
 */
export function toDisplayText(text: string, names: string[]): string {
  return translateMaskRuns(maskText(text, names));
}
