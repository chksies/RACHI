/**
 * Every pattern RACHI uses to understand job mail lives here, so adding support for a new
 * ATS or a reworded rejection is a data change, not a code change. No AI is involved:
 * each template is a precise rule built from real emails.
 */
import type { ApplicationStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Application states
// ---------------------------------------------------------------------------

/** Once an application reaches one of these, nothing more needs checking. */
export const TERMINAL_STATES: readonly ApplicationStatus[] = ["rejected", "offer", "withdrawn"];

export function isTerminalState(status: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

/**
 * A positive signal only: most ATS mail is no-reply, but plenty of real rejections come
 * from a person. Never use this to filter mail out.
 */
export const NOREPLY_SENDER = /no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply/i;

export const ATS_DOMAINS = [
  "lever.co",
  "ashbyhq.com",
  "myworkday.com",
  "greenhouse-mail.io",
  "greenhouse.io",
  "icims.com",
  "smartrecruiters.com",
  "workable.com",
  "bamboohr.com",
  "hibob.com",
  "trakstar.com",
  "dayforce.com",
  "adp.com",
];

/** Domains that say nothing about who the employer is. */
export const NON_EMPLOYER_DOMAINS =
  /^(gmail|googlemail|outlook|hotmail|yahoo|lever|ashbyhq|myworkday|workday|greenhouse|greenhouse-mail|icims|dayforce|ceridian|clearcompany|adp|workable|smartrecruiters|taleo|oraclecloud|successfactors|bamboohr|jobvite|hibob|breezy|recruitee|jazzhr|teamtailor|ultipro|trakstar|sonichire|linkedin|sendgrid|mailchimp|amazonses)$/;

// ---------------------------------------------------------------------------
// Phrases: what kind of mail is this?
// Strong phrases are decisive on their own; weak ones only add up.
// ---------------------------------------------------------------------------

export interface PhraseSet {
  strong: string[];
  weak: string[];
}

export const REJECTION: PhraseSet = {
  strong: [
    "moving forward with other candidates",
    "move forward with other candidates",
    "not moving forward",
    "won't be moving forward",
    "will not be moving forward",
    "unable to proceed",
    "unable to move forward",
    "not be proceeding",
    "will not be proceeding",
    "regret to inform you",
    "decided not to proceed",
    "decided to pursue other candidates",
    "decided not to move forward",
    "not to move forward with your",
    "not moving forward with your",
    "we will not be moving forward",
    "position has been filled",
  ],
  weak: ["other candidates", "not selected", "unfortunately", "not be able to offer"],
};

export const CONFIRMATION: PhraseSet = {
  strong: [
    "thank you for applying",
    "thanks for applying",
    "thank you for your application",
    "thank you for your interest in",
    "we have received your application",
    "received your application",
    "received your job application",
    "your application was sent to",
    "application received",
    "application confirmation",
    "successfully submitted",
    "application submitted",
  ],
  weak: ["we received your application", "your application is under review", "under review"],
};

export const INTERVIEW: PhraseSet = {
  strong: [
    "invite you to interview",
    "invitation to interview",
    "interview invitation",
    "schedule an interview",
    "schedule a call",
    "phone screen",
    "next steps",
    "coding assessment",
    "coding challenge",
    "online assessment",
    "take-home",
    "book a time",
    "your availability",
  ],
  weak: ["interview", "assessment"],
};

export const STATUS: PhraseSet = {
  strong: ["application status", "status update", "progress update", "your application update", "update on your application"],
  weak: ["under review"],
};

// ---------------------------------------------------------------------------
// Spam: how likely is this to be marketing rather than job mail?
// Real ATS mail can carry an "unsubscribe" footer (IBM, Dayforce, Wellfound and Mercor all
// do), so it only lowers confidence; a strong template match always overrides it.
// ---------------------------------------------------------------------------

export const SPAM_UNSUBSCRIBE = /unsubscribe/i;

export const SPAM_PROMO: RegExp[] = [
  /\bsale\b/i,
  /\b\d{1,2}% off\b/i,
  /\bpromo(?:tion|tional)?s?\b/i,
  /\bdiscount\b/i,
  /\bcoupon\b/i,
  /\bfree shipping\b/i,
  /\blimited[- ]time\b/i,
];

/** Account chores sent through the same ATS are not application events. */
export const ACCOUNT_CHORE_SUBJECT = /security code|verification code|verify your email|reset your password/i;

// ---------------------------------------------------------------------------
// Extraction templates: where do company and role come from?
// ---------------------------------------------------------------------------

export interface Match {
  company?: string;
  role?: string;
  location?: string;
}

export interface Template {
  name: string;
  re: RegExp;
  pick: (m: RegExpMatchArray) => Match;
}

/** Subject templates, most specific first. The first one that matches wins. */
export const SUBJECT_TEMPLATES: Template[] = [
  // Ashby: "Application Received — Software Engineer, Dev Velocity at Render"
  { name: "ashby", re: /^application received\s*[—–-]\s*(.+?)\s+at\s+(.+?)\s*$/i, pick: (m) => ({ role: m[1], company: m[2] }) },
  // Workday: "Application Received for Software Developer Intern at Perseus Group"
  { name: "workday", re: /^application received for\s+(.+?)\s+at\s+(.+?)\s*$/i, pick: (m) => ({ role: m[1], company: m[2] }) },
  // Greenhouse: "Thank you for applying to the Software Engineer role at Greenhouse!"
  { name: "greenhouse-role", re: /thank you for applying to the\s+(.+?)\s+role at\s+(.+?)\s*!?\s*$/i, pick: (m) => ({ role: m[1], company: m[2] }) },
  // Greenhouse: "Your application for Software Engineering Intern 2027 (Toronto) at Pinterest"
  { name: "greenhouse-update", re: /^your application for\s+(.+)\s+at\s+(.+?)\s*$/i, pick: (m) => ({ role: m[1], company: m[2] }) },
  // Greenhouse: "An update on your application to Canonical - Cloud Field Engineer"
  { name: "greenhouse-status", re: /^an update on your application to\s*(.+?)\s+[-–—]\s+(.+)$/i, pick: (m) => ({ company: m[1], role: m[2] }) },
  // LinkedIn: "Your application was sent to Acme", "Chukwuemeka, your application was sent to Acme"
  { name: "linkedin", re: /your application was sent to\s+(.+?)\s*$/i, pick: (m) => ({ company: m[1] }) },
  // Wellfound: "Application to Feathery successfully submitted"
  { name: "wellfound", re: /^application to\s+(.+?)\s+(?:was\s+)?successfully submitted/i, pick: (m) => ({ company: m[1] }) },
  // "Quora | Application | Role - Quora (Remote)", "Marvell | Application Confirmation | Role"
  {
    name: "pipe",
    re: /^([^|]+?)\s*\|\s*(?:application(?: confirmation)?|thank you for applying!?)\s*\|\s*(.+)$/i,
    pick: (m) => ({ company: m[1], role: m[2] }),
  },
  // iCIMS: "Thank you for applying at CA-PE-Charlottetown" (a location code, not a company)
  { name: "icims-location", re: /[Tt]hank you for applying at\s+([A-Z]{2}-[A-Z]{2}-.+?)\s*$/, pick: (m) => ({ location: m[1] }) },
  // HiBob: "Thank you for applying at Synpulse!"
  { name: "hibob", re: /thank you for applying at\s+(.+?)\s*!?\s*$/i, pick: (m) => ({ company: m[1] }) },
  // Lever: "Thanks for your interest in Betstamp, Chukwuemeka"
  { name: "lever-interest", re: /thanks for your interest in\s+(.+?)\s*(?:,|!|$)/i, pick: (m) => ({ company: m[1] }) },
  // Lever: "Thank you for your application to Mechanical Orchard"
  { name: "lever", re: /thank you for your application to\s+(.+?)\s*$/i, pick: (m) => ({ company: m[1] }) },
  // "Thank you for applying for IT Operations Analyst (12414)": the tail is a role
  { name: "applying-for-role", re: /thank you for applying for\s+(.+?)\s*$/i, pick: (m) => ({ role: m[1] }) },
  // "Thanks for applying to Toast!", "Thank you for Applying to Amplitude", "...Application with Remarcable, Inc."
  {
    name: "applying-to",
    re: /(?:thank you|thanks) for (?:your )?(?:applying|application)\s+(?:to|with)\s+(.+?)\s*!?\s*$/i,
    pick: (m) => ({ company: m[1] }),
  },
  // "Update on your application to Superhuman", "...toGenius AI"
  { name: "update-on", re: /update on your application to\s*(.+?)\s*$/i, pick: (m) => ({ company: m[1] }) },
];

/**
 * Body templates, used only when the subject and sender name no company. They read the
 * standard sentence every confirmation contains: "Your application to [TITLE] at [COMPANY]".
 */
export const BODY_TEMPLATES: Template[] = [
  // "applying for the Software Engineer position at Synpulse."
  {
    name: "body-position-at",
    re: /appl(?:ying|ication) (?:for|to) the (.{3,120}?) (?:position|role|opportunity) at ([A-Z][^.!,\n]{1,50}?)\s*[.!,]/,
    pick: (m) => ({ role: m[1], company: m[2] }),
  },
  // "applying to the role of AI Consultant - 135564 at IBM."
  {
    name: "body-role-of",
    re: /(?:applying|applied) (?:to|for) the (?:role|position) of (.{3,150}?) at ([A-Z][^.!,\n]{1,40}?)\s*[.!,]/,
    pick: (m) => ({ role: m[1], company: m[2] }),
  },
  // "Your application to [TITLE] at [COMPANY]"
  {
    name: "body-your-application",
    re: /[Yy]our application (?:to|for) (?:the )?(.{3,120}?) at ([A-Z][^.!,\n]{1,50}?)\s*[.!,\n]/,
    pick: (m) => ({ role: m[1], company: m[2] }),
  },
  // "...to confirm that York Hills Centre has received your job application."
  { name: "body-confirm-that", re: /confirm that (.{2,80}?) has received your (?:job )?application/, pick: (m) => ({ company: m[1] }) },
  // "Thank you for your interest in Genius ERP and the Developer position"
  {
    name: "body-interest-in",
    // Capitalised words only, so a job title ("Early Career Software Developer") is not mistaken for a company.
    re: /interest in ([A-Z][\w&'’.-]*(?: [A-Z&][\w&'’.-]*){0,4})(?= and (?:the|our|look)|[.!,])/,
    pick: (m) => ({ company: m[1] }),
  },
  // "...join us here at Bond."
  { name: "body-here-at", re: /here at ([A-Z][\w&-]+)/, pick: (m) => ({ company: m[1] }) },
];

