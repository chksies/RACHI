import type { EmailKind, ParsedApplication, RawEmail } from "../types.js";

export type Parser = (email: RawEmail) => ParsedApplication | null;

/** "CAE Careers <cae@myworkday.com>" -> { name: "CAE Careers", local: "cae", domain: "myworkday.com" } */
export function splitSender(from: string): { name: string; local: string; domain: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^@>]+)@([^>]+)>\s*$/);
  if (m) return { name: m[1]!.trim(), local: m[2]!.trim(), domain: m[3]!.trim().toLowerCase() };
  const bare = from.match(/^\s*<?([^@\s<]+)@([^\s>]+)>?\s*$/);
  if (bare) return { name: "", local: bare[1]!, domain: bare[2]!.toLowerCase() };
  return { name: from.trim(), local: "", domain: "" };
}

/** Strip boilerplate from sender display names and subject fragments: "Stripe Recruiting Team" -> "Stripe". */
export function cleanCompany(raw: string): string {
  return raw
    .replace(/\(.*?\)/g, " ")
    .replace(/@\s*\w+/g, " ")
    .replace(/['’]s\s+(hiring|recruiting)\s+team/gi, " ")
    .replace(/workday\.?admin/gi, " ")
    .replace(
      /\b(careers?|recruiting|recruitment|talent( acquisition)?|hiring|jobs?|team|hr|human resources|no-?reply|notifications?|workday|admin)\b/gi,
      " ",
    )
    .replace(/["“”]/g, "")
    .replace(/[\s\-–—,.:!|]+$/g, "")
    .replace(/^[\s\-–—,.:!|]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Company from the sender when the subject doesn't name one. Null for generic senders. */
export function senderCompany(from: string): string | null {
  const s = splitSender(from);
  const fromName = cleanCompany(s.name);
  if (fromName.length >= 2) return fromName;
  if (s.domain.endsWith("myworkday.com") && /^[a-z0-9-]{2,}$/i.test(s.local) && !/workday|reply/i.test(s.local)) {
    return s.local[0]!.toUpperCase() + s.local.slice(1);
  }
  return null;
}

export function sourceOf(from: string): string {
  const d = splitSender(from).domain;
  if (d.includes("lever.co")) return "lever";
  if (d.includes("ashbyhq.com")) return "ashby";
  if (d.includes("myworkday.com")) return "workday";
  if (d.includes("greenhouse")) return "greenhouse";
  if (d.includes("icims.com")) return "icims";
  return "email";
}

/** "Software Engineer - Quora (Remote)" -> "Software Engineer" when the tail repeats the company. */
function cleanRole(role: string | null, company: string): string | null {
  if (!role) return null;
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trimmed = role.replace(new RegExp(`\\s+[-–—]\\s+${escaped}.*$`, "i"), "").trim();
  return trimmed || null;
}

interface Match {
  company?: string;
  role?: string;
  location?: string;
}

/** Subject patterns, most specific first. The first one that matches wins. */
const SUBJECT_PATTERNS: { re: RegExp; pick: (m: RegExpMatchArray) => Match }[] = [
  // Ashby: "Application Received — Software Engineer, Dev Velocity at Render"
  { re: /^application received\s*[—–-]\s*(.+?)\s+at\s+(.+?)\s*$/i, pick: (m) => ({ role: m[1], company: m[2] }) },
  // Workday: "Application Received for Software Developer Intern at Perseus Group"
  { re: /^application received for\s+(.+?)\s+at\s+(.+?)\s*$/i, pick: (m) => ({ role: m[1], company: m[2] }) },
  // Greenhouse: "Thank you for applying to the Software Engineer role at Greenhouse!"
  { re: /thank you for applying to the\s+(.+?)\s+role at\s+(.+?)\s*!?\s*$/i, pick: (m) => ({ role: m[1], company: m[2] }) },
  // Greenhouse: "Your application for Software Engineering Intern 2027 (Toronto) at Pinterest"
  { re: /^your application for\s+(.+)\s+at\s+(.+?)\s*$/i, pick: (m) => ({ role: m[1], company: m[2] }) },
  // Greenhouse: "An update on your application to Canonical - Cloud Field Engineer"
  { re: /^an update on your application to\s*(.+?)\s+[-–—]\s+(.+)$/i, pick: (m) => ({ company: m[1], role: m[2] }) },
  // "Quora | Application | Role - Quora (Remote)", "Marvell | Application Confirmation | Role"
  {
    re: /^([^|]+?)\s*\|\s*(?:application(?: confirmation)?|thank you for applying!?)\s*\|\s*(.+)$/i,
    pick: (m) => ({ company: m[1], role: m[2] }),
  },
  // iCIMS: "Thank you for applying at CA-PE-Charlottetown" (a location code, not a company)
  { re: /thank you for applying at\s+(.+?)\s*$/i, pick: (m) => ({ location: m[1] }) },
  // Lever: "Thanks for your interest in Betstamp, Chukwuemeka"
  { re: /thanks for your interest in\s+(.+?)\s*(?:,|!|$)/i, pick: (m) => ({ company: m[1] }) },
  // Lever: "Thank you for your application to Mechanical Orchard"
  { re: /thank you for your application to\s+(.+?)\s*$/i, pick: (m) => ({ company: m[1] }) },
  // "Thank you for applying for IT Operations Analyst (12414)": the tail is a role
  { re: /thank you for applying for\s+(.+?)\s*$/i, pick: (m) => ({ role: m[1] }) },
  // "Thanks for applying to Toast!", "Thank you for Applying to Amplitude", "...Application with Remarcable, Inc."
  {
    re: /(?:thank you|thanks) for (?:your )?(?:applying|application)\s+(?:to|with)\s+(.+?)\s*!?\s*$/i,
    pick: (m) => ({ company: m[1] }),
  },
  // "Update on your application to Superhuman", "...toGenius AI"
  { re: /update on your application to\s*(.+?)\s*$/i, pick: (m) => ({ company: m[1] }) },
];

// Subjects that name no company but are clearly application mail; the sender supplies it.
const SENDER_ONLY_SUBJECT =
  /thank you for (?:your )?(?:applying|application|interest)|application (?:received|confirmation)|we have received your application|update on your|your interest in/i;

export function parseEmail(email: RawEmail, kind: EmailKind = "confirmation"): ParsedApplication | null {
  const source = sourceOf(email.from);
  let match: Match = {};
  for (const { re, pick } of SUBJECT_PATTERNS) {
    const m = email.subject.match(re);
    if (m) {
      match = pick(m);
      break;
    }
  }

  let company = match.company ? cleanCompany(match.company) : "";
  if (!company && (kind === "confirmation" || SENDER_ONLY_SUBJECT.test(email.subject) || source !== "email")) {
    company = senderCompany(email.from) ?? "";
  }
  if (!company) return null;

  return {
    company,
    role: cleanRole(match.role?.trim() ?? null, company),
    location: match.location ?? null,
    source,
  };
}
