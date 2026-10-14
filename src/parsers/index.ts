import { BODY_TEMPLATES, NON_EMPLOYER_DOMAINS, SUBJECT_TEMPLATES, type Match, type Template } from "../templates.js";
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
    .split(/\s\|\s/)[0]! // "MaintainX! | Merci d'avoir postulé" -> "MaintainX!"
    .replace(/\(.*?\)/g, " ")
    .replace(/@\s*\w+/g, " ")
    .replace(/['’]s\s+(hiring|recruiting)\s+team/gi, " ")
    .replace(/workday\.?admin/gi, " ")
    .replace(
      /\b(careers?|recruiting|recruitment|talent( acquisition)?|hiring|jobs?|team|hr|human resources|no-?reply|notifications?|workday|admin)\b/gi,
      " ",
    )
    .replace(/["“”]/g, "")
    .replace(/(?:\s+&|\s+and)\s*$/i, "") // "Spare People &" left over after "Culture Team" is stripped
    .replace(/[\s\-–—,.:!|]+$/g, "")
    .replace(/^[\s\-–—,.:!|]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * "Margarita Sandomirskaia <margarita@mastra.ai>" is a person, not a company: two or three
 * name-like words, one of which is in the address, sent from a real company domain we can
 * name instead. "Texas Instruments <recruiting@ti.com>" is not (no name word in the address).
 */
function looksLikePerson(from: string): boolean {
  const { name, local } = splitSender(from);
  const words = cleanCompany(name).split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 3 || !domainCompany(from)) return false;
  // "VC3 Inc" or "Acme Corp" are companies, however they are addressed.
  if (words.some((w) => /^(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|group|systems|technologies)\.?$/i.test(w))) return false;
  const address = local.toLowerCase().replace(/[^a-z]/g, "");
  return words.some((w) => {
    const letters = w.toLowerCase().replace(/[^a-z]/g, "");
    return letters.length >= 3 && address.includes(letters);
  });
}

/** Company from the sender's display name. Null for generic senders like "Human Resources" and for people. */
function senderName(from: string): string | null {
  if (looksLikePerson(from)) return null;
  const name = cleanCompany(splitSender(from).name);
  return name.length >= 2 ? name : null;
}

/** Workday mails come from {company}@myworkday.com. */
function workdayLocalPart(from: string): string | null {
  const s = splitSender(from);
  if (s.domain.endsWith("myworkday.com") && /^[a-z0-9-]{2,}$/i.test(s.local) && !/workday|reply/i.test(s.local)) {
    return s.local[0]!.toUpperCase() + s.local.slice(1);
  }
  return null;
}

/** Company from the sender's own domain: careers@talent.autodesk.com -> "Autodesk". Null for ATS and mail hosts. */
export function domainCompany(from: string): string | null {
  const labels = splitSender(from).domain.split(".");
  const label = labels.length >= 2 ? labels[labels.length - 2]! : "";
  if (!label || NON_EMPLOYER_DOMAINS.test(label)) return null;
  return label[0]!.toUpperCase() + label.slice(1);
}

/** Company from the sender when the subject doesn't name one. Null for generic senders. */
export function senderCompany(from: string): string | null {
  return senderName(from) ?? workdayLocalPart(from);
}

export function sourceOf(from: string): string {
  const d = splitSender(from).domain;
  if (d.includes("lever.co")) return "lever";
  if (d.includes("ashbyhq.com")) return "ashby";
  if (d.includes("myworkday.com")) return "workday";
  if (d.includes("greenhouse")) return "greenhouse";
  if (d.includes("icims.com")) return "icims";
  if (d.includes("hibob.com")) return "hibob";
  if (d.includes("bamboohr.com")) return "bamboohr";
  return "email";
}

/** "Software Engineer - Quora (Remote)" -> "Software Engineer" when the tail repeats the company. */
function cleanRole(role: string | null, company: string): string | null {
  if (!role) return null;
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trimmed = role.replace(new RegExp(`\\s+[-–—]\\s+${escaped}.*$`, "i"), "").trim();
  return trimmed || null;
}

function firstMatch(templates: Template[], text: string): Match {
  for (const t of templates) {
    const m = text.match(t.re);
    if (m) return t.pick(m);
  }
  return {};
}

/**
 * Where the company comes from, in order of trust:
 * subject template -> sender display name -> body template -> workday sender -> sender domain.
 * Returns null when none of them can name one; the email then goes to the review queue.
 */
export function parseEmail(email: RawEmail, _kind: EmailKind = "confirmation"): ParsedApplication | null {
  const source = sourceOf(email.from);
  const fromSubject = firstMatch(SUBJECT_TEMPLATES, email.subject);

  let company = fromSubject.company ? cleanCompany(fromSubject.company) : "";
  let role = fromSubject.role ?? null;
  const location = fromSubject.location ?? null;

  if (!company) company = senderName(email.from) ?? "";
  if (!company) {
    const fromBody = firstMatch(BODY_TEMPLATES, email.body.replace(/\s+/g, " "));
    if (fromBody.company) {
      company = cleanCompany(fromBody.company);
      role ??= fromBody.role ?? null;
    }
  }
  if (!company) company = workdayLocalPart(email.from) ?? "";
  if (!company) company = domainCompany(email.from) ?? "";
  if (!company) return null;

  return { company, role: cleanRole(role?.trim() ?? null, company), location, source };
}
