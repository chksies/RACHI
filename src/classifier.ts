import { splitSender } from "./parsers/index.js";
import {
  ACCOUNT_CHORE_SUBJECT,
  ATS_DOMAINS,
  CONFIRMATION,
  INTERVIEW,
  NOREPLY_SENDER,
  REJECTION,
  SPAM_PROMO,
  SPAM_UNSUBSCRIBE,
  STATUS,
  SUBJECT_TEMPLATES,
  type PhraseSet,
} from "./templates.js";
import type { EmailKind, RawEmail } from "./types.js";

export interface Classification {
  kind: EmailKind;
  score: number;
}

type Scored = Exclude<EmailKind, "noise">;

const PHRASES: Record<Scored, PhraseSet> = {
  rejection: REJECTION,
  confirmation: CONFIRMATION,
  interview: INTERVIEW,
  status: STATUS,
};

/** Below this, a lone weak mention ("interview" in a newsletter) is not job mail. */
const MIN_SCORE = 2;

export function isFromAts(from: string): boolean {
  const lower = from.toLowerCase();
  return ATS_DOMAINS.some((d) => lower.includes(d));
}

function score(set: PhraseSet, subject: string, body: string): { score: number; strong: number } {
  let total = 0;
  let strong = 0;
  for (const p of set.strong) {
    if (subject.includes(p)) total += 6; // subject hit counts double
    if (body.includes(p)) total += 3;
    if (subject.includes(p) || body.includes(p)) strong++;
  }
  for (const p of set.weak) {
    if (subject.includes(p)) total += 2;
    if (body.includes(p)) total += 1;
  }
  return { score: total, strong };
}

function spamPenalty(subject: string, body: string): number {
  let penalty = SPAM_UNSUBSCRIBE.test(body) ? 2 : 0;
  for (const re of SPAM_PROMO) if (re.test(subject) || re.test(body)) penalty += 2;
  return penalty;
}

/**
 * Rule-based and explainable:
 * 1. a decisive rejection phrase always wins (rejection letters often say "thank you for applying");
 * 2. otherwise the highest-scoring kind wins;
 * 3. spam signals subtract, no-reply senders add a little, ATS senders are job mail by definition.
 */
export function classify(email: Pick<RawEmail, "from" | "subject" | "body">): Classification {
  const subject = email.subject.toLowerCase();
  const body = email.body.toLowerCase();
  const fromAts = isFromAts(email.from);

  if (ACCOUNT_CHORE_SUBJECT.test(subject)) return { kind: "noise", score: 0 };

  const scores = Object.fromEntries(
    (Object.entries(PHRASES) as [Scored, PhraseSet][]).map(([kind, set]) => [kind, score(set, subject, body)]),
  ) as Record<Scored, { score: number; strong: number }>;

  let best: Classification = { kind: "noise", score: 0 };
  for (const kind of Object.keys(scores) as Scored[]) {
    if (scores[kind].score > best.score) best = { kind, score: scores[kind].score };
  }
  if (scores.rejection.strong > 0) best = { kind: "rejection", score: scores.rejection.score };

  if (best.kind !== "noise") {
    // A known confirmation template in the subject is as strong as evidence gets.
    const templated = SUBJECT_TEMPLATES.some((t) => t.re.test(email.subject));
    const sender = splitSender(email.from);
    const positive = (NOREPLY_SENDER.test(sender.local) ? 1 : 0) + (fromAts ? 2 : 0) + (templated ? 4 : 0);
    const net = best.score + positive - spamPenalty(subject, body);
    if (net < MIN_SCORE && !fromAts) return { kind: "noise", score: 0 };
    best = { kind: best.kind, score: net };
  }

  // Mail from a known ATS is job-related by definition, even if no phrase matched.
  if (best.kind === "noise" && fromAts) return { kind: "status", score: 1 };
  return best;
}
