import type { Db } from "./db.js";
import type { Application, ApplicationStatus } from "./types.js";

const SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|software|technologies|technology|group|canada|usa)\b\.?/g;

/** "Greenhouse Software, Inc." and "greenhouse" both become "greenhouse". */
export function companyKey(company: string): string {
  return company
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameRole(a: string | null, b: string | null): boolean {
  if (!a || !b) return true; // unknown role: assume the same application
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Find the existing application this email belongs to. Same company and a matching
 * (or unknown) role is a match; same company with a different known role is a
 * separate application.
 */
export function findExisting(db: Db, company: string, role: string | null): Application | null {
  const rows = db
    .prepare("SELECT * FROM applications WHERE company_key = ? ORDER BY id DESC")
    .all(companyKey(company)) as Application[];
  return rows.find((r) => sameRole(r.role, role)) ?? null;
}

/** Look for a known company mentioned in free text (sender or subject) when no parser matched. */
export function findByText(db: Db, text: string): Application | null {
  const haystack = ` ${companyKey(text)} `;
  const rows = db
    .prepare("SELECT * FROM applications ORDER BY length(company_key) DESC, id DESC")
    .all() as Application[];
  return rows.find((r) => r.company_key && haystack.includes(` ${r.company_key} `)) ?? null;
}

const RANK: Record<ApplicationStatus, number> = { applied: 0, interviewing: 1, offer: 2, rejected: 3 };

/** A late confirmation must not overwrite a rejection; otherwise the newer signal wins. */
export function nextStatus(current: ApplicationStatus, incoming: ApplicationStatus): ApplicationStatus {
  if (incoming === "rejected") return current === "offer" ? current : "rejected";
  if (current === "rejected") return incoming === "offer" ? "offer" : current;
  return RANK[incoming] > RANK[current] ? incoming : current;
}
