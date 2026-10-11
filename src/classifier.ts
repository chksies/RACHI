import type { EmailKind, RawEmail } from "./types.js";

const ATS_DOMAINS = ["lever.co", "ashbyhq.com", "myworkday.com", "greenhouse-mail.io", "greenhouse.io", "icims.com"];

const SIGNALS: Record<Exclude<EmailKind, "noise">, string[]> = {
  rejection: [
    "not moving forward",
    "moving forward with other candidates",
    "other candidates",
    "not selected",
    "unfortunately",
    "decided not to proceed",
    "will not be moving",
  ],
  confirmation: [
    "thank you for applying",
    "thank you for your application",
    "application received",
    "we have received your application",
    "received your application",
  ],
  interview: ["interview", "assessment", "schedule a call", "availability", "coding challenge"],
  status: ["application status", "under review", "your application update"],
};

export interface Classification {
  kind: EmailKind;
  score: number;
}

export function isFromAts(from: string): boolean {
  const lower = from.toLowerCase();
  return ATS_DOMAINS.some((d) => lower.includes(d));
}

/** Rule-based scoring: subject hits count double, highest-scoring kind wins. */
export function classify(email: Pick<RawEmail, "from" | "subject" | "body">): Classification {
  const subject = email.subject.toLowerCase();
  const body = email.body.toLowerCase();

  // Account chores sent through the same ATS are not application events.
  if (/security code|verification code|verify your email|reset your password/.test(subject)) {
    return { kind: "noise", score: 0 };
  }

  let best: Classification = { kind: "noise", score: 0 };
  for (const [kind, phrases] of Object.entries(SIGNALS) as [Exclude<EmailKind, "noise">, string[]][]) {
    let score = 0;
    for (const p of phrases) {
      if (subject.includes(p)) score += 2;
      if (body.includes(p)) score += 1;
    }
    if (score > best.score) best = { kind, score };
  }

  // Mail from a known ATS is job-related by definition, even if no phrase matched.
  if (best.kind === "noise" && isFromAts(email.from)) return { kind: "status", score: 1 };
  return best;
}
