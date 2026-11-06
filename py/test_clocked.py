"""Case Companion — Clocked smoke test on the synthetic demo case.

Loads the 4 synthetic documents, then calls Extract (15 fields), Decide
(4 questions), and Fill (one-page brief record) in order. Prints the full
JSON of every call and checks Extract against the known synthetic values.

Usage (from repo root):
    .venv\\Scripts\\python.exe py\\test_clocked.py        # Windows
    .venv/bin/python py/test_clocked.py                  # macOS / Linux

Requires CLOCKED_API_KEY in the environment (see py/.env.example).
Exits non-zero if the key is missing, a call fails, or any Extract check fails.
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from clocked_client import get_client  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = [
    ("loan_agreement", "synthetic-case/01-loan-agreement.txt"),
    ("notice_of_default", "synthetic-case/02-notice-of-default.txt"),
    ("complaint", "synthetic-case/03-complaint.txt"),
    ("prior_court_order", "synthetic-case/04-prior-court-order.txt"),
]

# --- Extract: 15 fields -------------------------------------------------
EXTRACT_FIELDS = {
    "lender": "Name of the lender bank",
    "borrower": "Name of the borrower",
    "guarantor": "Name of the personal guarantor",
    "loan_amount": "Original loan principal amount, with currency",
    "monthly_payment": "Monthly payment amount, with currency",
    "balance_at_default": "Outstanding principal balance stated at default",
    "amount_to_cure": "Total amount required to cure the default",
    "loan_date": "Date of the loan agreement",
    "default_date": "Date of the notice of default",
    "cure_deadline": "Deadline to cure the default",
    "court": "Name of the court hearing the case",
    "case_number": "Court case number",
    "next_hearing_datetime": "Date and time of the next hearing",
    "bank_to_produce_by": "Deadline for the bank to produce documents",
    "amount_claimed": "Total amount claimed in the complaint",
}

# Required substrings (case-insensitive) for each extracted value.
EXPECTED = {
    "lender": ["Meridian Community Bank"],
    "borrower": ["Ridgeway Hardware"],
    "guarantor": ["Whitfield"],
    "loan_amount": ["185,000"],
    "monthly_payment": ["3,762"],
    "balance_at_default": ["142,380"],
    "amount_to_cure": ["15,800.40"],
    "loan_date": ["March 12, 2024"],
    "default_date": ["September 28, 2026"],
    "cure_deadline": ["October 28, 2026"],
    "court": ["Montgomery County"],
    "case_number": ["CV-2026-01482"],
    "next_hearing_datetime": ["November 12, 2026", "9:30"],
    "bank_to_produce_by": ["November 10, 2026"],
    "amount_claimed": ["147,292"],
}

# --- Decide: 4 questions ------------------------------------------------
DECIDE_QUESTIONS = {
    "hearing_type": {
        "type": "choice",
        "criteria": {
            "status_conference": "A routine status or scheduling conference.",
            "motion_hearing": "A hearing to argue a filed motion.",
            "trial": "A trial on the merits.",
            "not_established": "The documents do not establish the hearing type.",
        },
    },
    "continuance_likely": {
        "type": "noul",
        "instructions": (
            "Is another continuance likely — i.e., do the documents suggest "
            "the court may continue the case again (prior continuance, "
            "settlement talks ordered, production still pending)?"
        ),
    },
    "settlement_possible": {
        "type": "noul",
        "instructions": (
            "Is settlement realistically in play — i.e., did the court direct "
            "settlement discussion, or do the documents show room to negotiate?"
        ),
    },
    "prep_priority": {
        "type": "score",
        "criteria": [
            "1 - routine file review only",
            "2 - light preparation",
            "3 - standard hearing preparation",
            "4 - intensive preparation",
            "5 - urgent, drop-everything preparation",
        ],
    },
}

# --- Fill: one-page brief record ----------------------------------------
FILL_FIELDS = {
    "caption": {
        "type": "extract",
        "description": "Case caption: the parties to the lawsuit",
        "infer": False,
    },
    "case_number": {
        "type": "extract",
        "description": "Court case number",
        "infer": False,
    },
    "next_hearing": {
        "type": "extract",
        "description": "Next hearing date, time, and type",
        "infer": False,
    },
    "amounts_at_issue": {
        "type": "extract",
        "description": "Key dollar amounts: loan, balance, cure, amount claimed",
        "list": True,
        "infer": False,
    },
    "bank_deadline": {
        "type": "extract",
        "description": "What the bank must produce and by when",
        "infer": False,
    },
    "hearing_type": {
        "type": "choice",
        "description": "Type of the upcoming hearing",
        "options": ["status conference", "motion hearing", "trial"],
    },
    "needs_settlement_report": {
        "type": "yes_no",
        "description": "Must the bank report on settlement discussions at the hearing?",
    },
    "chronology": {
        "type": "generate",
        "description": (
            "One short line per key event (loan, default, complaint, prior "
            "order, deadlines, next hearing), each with its date. "
            "Procedural facts only; no argument or legal advice."
        ),
        "format": "text",
        "max_tokens": 300,
    },
    "talking_points": {
        "type": "generate",
        "description": (
            "Three short factual status lines for the bank officer, each "
            "restating only facts stated in the documents: (1) the production "
            "deadline, (2) the payment-history facts, (3) the "
            "settlement-discussion direction. One fact per line, no argument "
            "and no legal advice."
        ),
        "format": "text",
        "max_tokens": 200,
    },
}


def get(obj, key, default=None):
    """Read key from a dict or attribute from an object."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def to_jsonable(obj):
    if isinstance(obj, dict):
        return {k: to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    if hasattr(obj, "__dict__") and not isinstance(obj, (str, bytes)):
        try:
            return to_jsonable(vars(obj))
        except TypeError:
            pass
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    return str(obj)


def norm(text):
    return re.sub(r"\s+", " ", str(text)).strip().lower()


def main():
    texts = {}
    for doc_id, rel in DOCS:
        with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
            texts[doc_id] = f.read()

    combined = "\n\n".join(
        f"===== DOCUMENT: {doc_id} ({rel}) =====\n{texts[doc_id]}"
        for doc_id, rel in DOCS
    )

    client = get_client()

    # NOTE: the Python SDK's Result IS the response body (a dict);
    # header info (model_ms, credits, cost_usd) rides along as attributes.
    print("=== EXTRACT (15 fields) ===")
    extract_res = client.extract(text=combined, fields=EXTRACT_FIELDS)
    print(json.dumps(to_jsonable(dict(extract_res)), indent=2))
    print(f"[model_ms={extract_res.model_ms} credits={extract_res.credits} cost_usd={extract_res.cost_usd}]")

    print("\n=== DECIDE (4 questions) ===")
    decide_res = client.decide(state=combined, questions=DECIDE_QUESTIONS)
    print(json.dumps(to_jsonable(dict(decide_res)), indent=2))
    print(f"[model_ms={decide_res.model_ms} credits={decide_res.credits} cost_usd={decide_res.cost_usd}]")

    print("\n=== FILL (brief record) ===")
    fill_res = client.fill(text=combined, fields=FILL_FIELDS)
    print(json.dumps(to_jsonable(dict(fill_res)), indent=2))
    print(f"[model_ms={fill_res.model_ms} credits={fill_res.credits} cost_usd={fill_res.cost_usd}]")

    print("\n=== EXTRACT CHECKS ===")
    failures = 0
    fields = get(extract_res, "fields", {}) or {}
    for name, needles in EXPECTED.items():
        entry = get(fields, name, {}) or {}
        value = get(entry, "value", "")
        if isinstance(value, list):  # list field: join items
            value = "; ".join(
                str(get(v, "value", v)) for v in value
            )
        hay = norm(value)
        missing = [n for n in needles if n.lower() not in hay]
        if missing:
            failures += 1
            print(f"FAIL {name}: value={value!r} missing {missing}")
        else:
            print(f"PASS {name}: {value!r}")

    if failures:
        print(f"\n{failures} Extract check(s) FAILED.")
        return 1
    print("\nAll Extract checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
