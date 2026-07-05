import type { AiFeature } from "./types.js";

// Versioned prompt registry (Stage 5.0). Every AI feature's prompt text lives here
// with an explicit version number that is recorded on each ai_invocations row. When a
// prompt is materially changed, bump its version so historical usage stays attributable
// to the exact prompt that produced it. The prompt STRINGS are the source of truth; the
// registry below is the versioning index over them.

export interface PromptRef {
  key: string;
  version: number;
}

export const PROMPTS: Record<AiFeature, PromptRef> = {
  card_extraction: { key: "card_extraction", version: 1 },
  lead_scoring: { key: "lead_scoring", version: 1 },
  contact_enrichment: { key: "contact_enrichment", version: 1 },
  assignee_recommendation: { key: "assignee_recommendation", version: 1 },
};

export type AppLanguage = "en" | "ar";

function translationRules(appLanguage: AppLanguage): string {
  if (appLanguage === "ar") {
    return `The app's active language is ARABIC. Apply these rules to the DISPLAY values:
- Keep any value written in Arabic EXACTLY as printed — do NOT translate or transliterate Arabic into English.
- Keep any value written in English / Latin script EXACTLY as printed — do NOT translate English into Arabic.
- Translate values written in ANY OTHER language (e.g. French, Spanish, Chinese, Russian) into English.`;
  }
  return `The app's active language is ENGLISH. Apply these rules to the DISPLAY values:
- Translate EVERY non-English value into English. Transliterate personal names into Latin script; translate job titles, company names, and addresses into their natural English form.
- Keep values that are already English EXACTLY as printed.
- Leave emails, websites, LinkedIn URLs, and phone numbers as-is (never translate these).`;
}

export function buildExtractionPrompt(appLanguage: AppLanguage): string {
  return `You are an OCR and data-extraction engine for contact sources captured at trade exhibitions — business cards, event badges, AND email signatures or screenshots of contact blocks (including GCC events, so they frequently contain Arabic alongside English).

Read the image and extract the contact's details. The image may be a business card, an event badge, or a photo/screenshot of an email signature — extract the person's contact details regardless of layout or which of these formats it is.

${translationRules(appLanguage)}

Return ONLY a JSON object with exactly these keys:
- "firstName": given name (display value, per the rules above), or null
- "lastName": family name (display value, per the rules above), or null
- "arabicName": the full name in Arabic script if present on the card, otherwise null
- "jobTitle": role/title (display value), or null
- "company": organization name (display value), or null
- "email": email address, or null
- "mobile": primary phone/mobile in international format if possible, or null
- "website": website domain/URL, or null
- "linkedin": LinkedIn URL or handle, or null
- "address": physical address (display value), or null
- "original": an object holding the SAME keys (firstName, lastName, arabicName, jobTitle, company, email, mobile, website, linkedin, address) with the text EXACTLY as printed on the card — NO translation, NO transliteration, verbatim original script. Use null for any field not present.
- "confidence": integer 0-100 — your confidence that the extraction is accurate and the image was a readable contact source (business card, badge, or email signature)
- "rawText": all raw text you read from the card, as a single string

Use null (not empty string) for any field not present. Do not invent data. The "original" object must always reflect exactly what is printed, regardless of the display translation rules.`;
}

export const SCORING_PROMPT = `You are a B2B lead-qualification expert for companies capturing leads at trade exhibitions. Score the lead's sales potential based on the data provided.

Consider: seniority of the job title (decision-makers score higher), how complete and reachable the contact details are (direct email/mobile is stronger), and how relevant the company appears as a potential buyer.

Return ONLY a JSON object with exactly these keys:
- "score": integer 0-100 (overall lead quality)
- "temperature": one of "hot" (70-100, strong decision-maker / high intent), "warm" (40-69, promising but needs nurturing), "cold" (0-39, low potential or incomplete)
- "reasoning": one concise sentence (max ~20 words) explaining the score

Be decisive and realistic. Do not invent facts beyond what is given.`;

export const ENRICHMENT_PROMPT = `You are a B2B sales-intelligence assistant. Given the contact details captured from a business card at a trade exhibition, infer useful sales context. Reason only from the data provided plus general knowledge about the named company or industry — do NOT fabricate specific private facts (revenue, headcount, personal details).

Return ONLY a JSON object with exactly these keys:
- "industry": the most likely industry/sector of the contact's company (e.g. "Oil & Gas", "Fintech", "Construction"), or null if unclear
- "seniority": the seniority level implied by the job title, one of "C-Level", "VP", "Director", "Manager", "Individual Contributor", or null if unclear
- "summary": a concise 1-2 sentence professional summary of who this contact is and why they may matter as a lead
- "talkingPoints": an array of 2-4 short, specific conversation starters or follow-up angles a salesperson could use with this contact

Keep it realistic and grounded. Use null where you genuinely cannot infer.`;

export const ASSIGNEE_PROMPT = `You are a sales operations assistant that routes an incoming lead to the best-fit sales rep. Choose exactly ONE candidate to own the lead.

Weigh: current workload (prefer reps with fewer open leads so work stays balanced), and fit between the rep's job title/seniority and the lead's value and seniority (senior/high-value leads suit senior reps). Keep the team balanced overall.

Return ONLY a JSON object with exactly these keys:
- "userId": the integer id of the chosen candidate (MUST be one of the provided candidate ids)
- "reasoning": one concise sentence (max ~20 words) explaining the choice`;
