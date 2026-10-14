export type EmailKind = "confirmation" | "rejection" | "interview" | "status" | "noise";

export type ApplicationStatus = "applied" | "interviewing" | "rejected" | "offer" | "withdrawn";

export interface RawEmail {
  id: string;
  from: string;
  subject: string;
  body: string;
  date: Date;
}

/** Every parser returns this shape, or null when it can't make sense of the email. */
export interface ParsedApplication {
  company: string;
  role: string | null;
  location: string | null;
  source: string; // which parser matched: ashby, lever, workday, icims, greenhouse, ...
}

export interface Application {
  id: number;
  company: string;
  company_key: string;
  role: string | null;
  location: string | null;
  date_applied: string | null;
  status: ApplicationStatus;
  source: string | null;
  gmail_message_id: string | null;
  notes: string | null;
}
