import { ai } from "@workspace/integrations-gemini-ai";
import { logger } from "./logger.js";

const MODEL = "gemini-2.5-flash";
const EXTRACTION_TIMEOUT_MS = 30_000;
const SCORING_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface ExtractedCardData {
  firstName: string | null;
  lastName: string | null;
  arabicName: string | null;
  jobTitle: string | null;
  company: string | null;
  email: string | null;
  mobile: string | null;
  website: string | null;
  linkedin: string | null;
  address: string | null;
}

export interface CardExtractionResult {
  fields: ExtractedCardData;
  confidence: number;
  rawOcr: string;
}

export interface LeadScoreResult {
  score: number;
  temperature: "hot" | "warm" | "cold";
  reasoning: string;
}

export interface LeadScoreInput {
  firstName?: string | null;
  lastName?: string | null;
  jobTitle?: string | null;
  contactCompany?: string | null;
  email?: string | null;
  mobile?: string | null;
  website?: string | null;
  linkedin?: string | null;
  country?: string | null;
  notes?: string | null;
}

const EMPTY_FIELDS: ExtractedCardData = {
  firstName: null,
  lastName: null,
  arabicName: null,
  jobTitle: null,
  company: null,
  email: null,
  mobile: null,
  website: null,
  linkedin: null,
  address: null,
};

function parseImage(imageData: string): { data: string; mimeType: string } {
  const match = /^data:(.+?);base64,(.*)$/s.exec(imageData.trim());
  if (match) {
    return { mimeType: match[1], data: match[2] };
  }
  return { mimeType: "image/jpeg", data: imageData.trim() };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("AI response was not valid JSON");
  }
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 && t.toLowerCase() !== "null" ? t : null;
}

function clampScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const EXTRACTION_PROMPT = `You are an OCR and data-extraction engine for business cards and event badges at trade exhibitions (including GCC events, so cards may contain Arabic).

Read the image and extract the contact's details. Return ONLY a JSON object with exactly these keys:
- "firstName": given name in Latin script, or null
- "lastName": family name in Latin script, or null
- "arabicName": the full name in Arabic script if present on the card, otherwise null
- "jobTitle": role/title, or null
- "company": organization name, or null
- "email": email address, or null
- "mobile": primary phone/mobile in international format if possible, or null
- "website": website domain/URL, or null
- "linkedin": LinkedIn URL or handle, or null
- "address": physical address, or null
- "confidence": integer 0-100 — your confidence that the extraction is accurate and the image was a readable card
- "rawText": all raw text you read from the card, as a single string

Use null (not empty string) for any field not present. Do not invent data.`;

export async function extractCardData(imageData: string): Promise<CardExtractionResult> {
  const { data, mimeType } = parseImage(imageData);
  if (!data || data.length < 100 || !/^image\//.test(mimeType)) {
    throw new Error("imageData is not a valid image payload");
  }

  const response = await withTimeout(
    ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: EXTRACTION_PROMPT },
            { inlineData: { mimeType, data } },
          ],
        },
      ],
      config: { responseMimeType: "application/json", maxOutputTokens: 8192 },
    }),
    EXTRACTION_TIMEOUT_MS,
    "card extraction",
  );

  const text = response.text ?? "";
  const parsed = extractJson(text) as Record<string, unknown>;

  return {
    fields: {
      ...EMPTY_FIELDS,
      firstName: str(parsed.firstName),
      lastName: str(parsed.lastName),
      arabicName: str(parsed.arabicName),
      jobTitle: str(parsed.jobTitle),
      company: str(parsed.company),
      email: str(parsed.email),
      mobile: str(parsed.mobile),
      website: str(parsed.website),
      linkedin: str(parsed.linkedin),
      address: str(parsed.address),
    },
    confidence: clampScore(parsed.confidence),
    rawOcr: str(parsed.rawText) ?? "",
  };
}

const SCORING_PROMPT = `You are a B2B lead-qualification expert for companies capturing leads at trade exhibitions. Score the lead's sales potential based on the data provided.

Consider: seniority of the job title (decision-makers score higher), how complete and reachable the contact details are (direct email/mobile is stronger), and how relevant the company appears as a potential buyer.

Return ONLY a JSON object with exactly these keys:
- "score": integer 0-100 (overall lead quality)
- "temperature": one of "hot" (70-100, strong decision-maker / high intent), "warm" (40-69, promising but needs nurturing), "cold" (0-39, low potential or incomplete)
- "reasoning": one concise sentence (max ~20 words) explaining the score

Be decisive and realistic. Do not invent facts beyond what is given.`;

export async function scoreLead(
  input: LeadScoreInput,
  eventName?: string | null,
): Promise<LeadScoreResult> {
  const lines = [
    `Name: ${[input.firstName, input.lastName].filter(Boolean).join(" ") || "(unknown)"}`,
    `Job title: ${input.jobTitle ?? "(unknown)"}`,
    `Company: ${input.contactCompany ?? "(unknown)"}`,
    `Email: ${input.email ?? "(none)"}`,
    `Mobile: ${input.mobile ?? "(none)"}`,
    `Website: ${input.website ?? "(none)"}`,
    `LinkedIn: ${input.linkedin ?? "(none)"}`,
    `Country: ${input.country ?? "(unknown)"}`,
    `Captured at event: ${eventName ?? "(unspecified)"}`,
    `Notes: ${input.notes ?? "(none)"}`,
  ].join("\n");

  const response = await withTimeout(
    ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [{ text: `${SCORING_PROMPT}\n\nLead:\n${lines}` }],
        },
      ],
      config: { responseMimeType: "application/json", maxOutputTokens: 8192 },
    }),
    SCORING_TIMEOUT_MS,
    "lead scoring",
  );

  const text = response.text ?? "";
  const parsed = extractJson(text) as Record<string, unknown>;

  const score = clampScore(parsed.score);
  let temperature = str(parsed.temperature)?.toLowerCase();
  if (temperature !== "hot" && temperature !== "warm" && temperature !== "cold") {
    temperature = score >= 70 ? "hot" : score >= 40 ? "warm" : "cold";
  }

  return {
    score,
    temperature: temperature as LeadScoreResult["temperature"],
    reasoning: str(parsed.reasoning) ?? "",
  };
}

export interface EnrichmentInput {
  firstName?: string | null;
  lastName?: string | null;
  jobTitle?: string | null;
  contactCompany?: string | null;
  email?: string | null;
  website?: string | null;
  linkedin?: string | null;
  country?: string | null;
  notes?: string | null;
}

export interface EnrichmentResult {
  industry: string | null;
  seniority: string | null;
  summary: string | null;
  talkingPoints: string[];
}

const ENRICHMENT_PROMPT = `You are a B2B sales-intelligence assistant. Given the contact details captured from a business card at a trade exhibition, infer useful sales context. Reason only from the data provided plus general knowledge about the named company or industry — do NOT fabricate specific private facts (revenue, headcount, personal details).

Return ONLY a JSON object with exactly these keys:
- "industry": the most likely industry/sector of the contact's company (e.g. "Oil & Gas", "Fintech", "Construction"), or null if unclear
- "seniority": the seniority level implied by the job title, one of "C-Level", "VP", "Director", "Manager", "Individual Contributor", or null if unclear
- "summary": a concise 1-2 sentence professional summary of who this contact is and why they may matter as a lead
- "talkingPoints": an array of 2-4 short, specific conversation starters or follow-up angles a salesperson could use with this contact

Keep it realistic and grounded. Use null where you genuinely cannot infer.`;

export async function enrichContact(input: EnrichmentInput): Promise<EnrichmentResult> {
  const lines = [
    `Name: ${[input.firstName, input.lastName].filter(Boolean).join(" ") || "(unknown)"}`,
    `Job title: ${input.jobTitle ?? "(unknown)"}`,
    `Company: ${input.contactCompany ?? "(unknown)"}`,
    `Email: ${input.email ?? "(none)"}`,
    `Website: ${input.website ?? "(none)"}`,
    `LinkedIn: ${input.linkedin ?? "(none)"}`,
    `Country: ${input.country ?? "(unknown)"}`,
    `Notes: ${input.notes ?? "(none)"}`,
  ].join("\n");

  const response = await withTimeout(
    ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [{ text: `${ENRICHMENT_PROMPT}\n\nContact:\n${lines}` }],
        },
      ],
      config: { responseMimeType: "application/json", maxOutputTokens: 8192 },
    }),
    SCORING_TIMEOUT_MS,
    "contact enrichment",
  );

  const text = response.text ?? "";
  const parsed = extractJson(text) as Record<string, unknown>;

  const seniorityRaw = str(parsed.seniority);
  const allowedSeniority = ["C-Level", "VP", "Director", "Manager", "Individual Contributor"];
  const seniority = seniorityRaw && allowedSeniority.some(s => s.toLowerCase() === seniorityRaw.toLowerCase())
    ? allowedSeniority.find(s => s.toLowerCase() === seniorityRaw.toLowerCase())!
    : null;

  const talkingPoints = Array.isArray(parsed.talkingPoints)
    ? parsed.talkingPoints.map(str).filter((p): p is string => p !== null).slice(0, 4)
    : [];

  return {
    industry: str(parsed.industry),
    seniority,
    summary: str(parsed.summary),
    talkingPoints,
  };
}

export function logAiError(context: string, err: unknown): void {
  logger.error({ err, context }, "AI request failed");
}
