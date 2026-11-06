import complaint from "../synthetic-case/03-complaint.txt?raw";
import loanAgreement from "../synthetic-case/01-loan-agreement.txt?raw";
import noticeOfDefault from "../synthetic-case/02-notice-of-default.txt?raw";
import priorCourtOrder from "../synthetic-case/04-prior-court-order.txt?raw";

export interface CaseDoc {
  id: string;
  title: string;
  short: string;
  date: string;
  text: string;
}

/** The 4 synthetic demo documents. Single source of truth: synthetic-case/. */
export const DEMO_DOCS: CaseDoc[] = [
  {
    id: "loan-agreement",
    title: "Loan Agreement",
    short: "Loan Agreement",
    date: "Mar 12, 2024",
    text: loanAgreement,
  },
  {
    id: "notice-of-default",
    title: "Notice of Default",
    short: "Default Notice",
    date: "Sep 28, 2026",
    text: noticeOfDefault,
  },
  {
    id: "complaint",
    title: "Complaint",
    short: "Complaint",
    date: "Oct 14, 2026",
    text: complaint,
  },
  {
    id: "prior-court-order",
    title: "Prior Court Order",
    short: "Court Order",
    date: "Oct 28, 2026",
    text: priorCourtOrder,
  },
];

export const CASE_META = {
  caption: "Meridian Community Bank v. Ridgeway Hardware LLC",
  court: "Circuit Court for Montgomery County, Maryland",
  caseNumber: "CV-2026-01482",
  hearing: "Status Conference — November 12, 2026, 9:30 AM",
};
