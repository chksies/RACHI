import type { ParsedApplication, RawEmail } from "../types.js";

export type Parser = (email: RawEmail) => ParsedApplication | null;

/** "CAE Careers <cae@myworkday.com>" -> { name: "CAE Careers", local: "cae", domain: "myworkday.com" } */
export function splitSender(from: string): { name: string; local: string; domain: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^@>]+)@([^>]+)>\s*$/);
  if (m) return { name: m[1]!.trim(), local: m[2]!.trim(), domain: m[3]!.trim().toLowerCase() };
  const bare = from.match(/^\s*([^@\s]+)@(\S+)\s*$/);
  if (bare) return { name: "", local: bare[1]!, domain: bare[2]!.toLowerCase() };
  return { name: from.trim(), local: "", domain: "" };
}

/** Drop noise words from sender display names: "Stripe Recruiting Team" -> "Stripe". */
export function cleanCompany(raw: string): string {
  return raw
    .replace(/\b(careers?|recruiting|recruitment|talent( acquisition)?|hiring|jobs?|team|hr|no-?reply|notifications?)\b/gi, "")
    .replace(/[\s\-–—,.:]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const SUBJECT_RE = {
  ashby: /^application received\s*[—–-]\s*(.+?)\s+at\s+(.+?)\s*$/i,
  lever: /thank you for your application to\s+(.+?)\s*$/i,
  icims: /thank you for applying at\s+(.+?)\s*$/i,
  greenhouse: /thank you for applying to the\s+(.+?)\s+role at\s+(.+?)\s*!?\s*$/i,
};

const ashby: Parser = ({ subject }) => {
  const m = subject.match(SUBJECT_RE.ashby);
  if (!m) return null;
  return { role: m[1]!, company: m[2]!, location: null, source: "ashby" };
};

const lever: Parser = ({ subject, body }) => {
  const m = subject.match(SUBJECT_RE.lever);
  if (!m) return null;
  const roleMatch = body.match(/(?:for|applying (?:for|to))\s+(?:the\s+)?(.+?)\s+(?:position|role)\b/i);
  return { company: m[1]!, role: roleMatch?.[1] ?? null, location: null, source: "lever" };
};

const workday: Parser = ({ from, subject }) => {
  const sender = splitSender(from);
  if (!sender.domain.endsWith("myworkday.com")) return null;
  if (!/thank you for your application/i.test(subject)) return null;
  const company = cleanCompany(sender.name) || sender.local;
  if (!company) return null;
  return { company, role: null, location: null, source: "workday" };
};

const icims: Parser = ({ from, subject }) => {
  const m = subject.match(SUBJECT_RE.icims);
  if (!m) return null;
  const company = cleanCompany(splitSender(from).name);
  if (!company) return null;
  return { company, role: null, location: m[1]!, source: "icims" };
};

const greenhouse: Parser = ({ subject }) => {
  const m = subject.match(SUBJECT_RE.greenhouse);
  if (!m) return null;
  return { role: m[1]!, company: m[2]!, location: null, source: "greenhouse" };
};

// Ordered: most specific first.
export const parsers: Parser[] = [ashby, greenhouse, lever, icims, workday];

export function parseEmail(email: RawEmail): ParsedApplication | null {
  for (const parse of parsers) {
    const result = parse(email);
    if (result) return { ...result, company: result.company.trim(), role: result.role?.trim() ?? null };
  }
  return null;
}
