import { GoogleGenAI } from "@google/genai";

// Credential resolution — two supported modes:
//   1. Replit AI integration proxy: AI_INTEGRATIONS_GEMINI_API_KEY +
//      AI_INTEGRATIONS_GEMINI_BASE_URL (both provided by the integration).
//   2. Direct Google Gemini API (portable/self-hosted): GEMINI_API_KEY only —
//      the SDK's default endpoint is used and no base-URL override is applied.
// The proxy pair takes precedence when both are present.
function resolveCredentials(): { apiKey: string; baseUrl?: string } | null {
  const proxyKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  const proxyUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  if (proxyKey && proxyUrl) return { apiKey: proxyKey, baseUrl: proxyUrl };
  const directKey = process.env.GEMINI_API_KEY ?? proxyKey;
  if (directKey) return { apiKey: directKey };
  return null;
}

export function isGeminiConfigured(): boolean {
  return resolveCredentials() !== null;
}

// Lazy singleton: the client is created on first use, NOT at import time, so an
// environment without any Gemini credential can still boot the API server —
// AI features degrade behind the provider's isConfigured() gate instead of
// crashing the whole process at startup.
let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (client) return client;
  const creds = resolveCredentials();
  if (!creds) {
    throw new Error(
      "Gemini is not configured. Set GEMINI_API_KEY (direct Google Gemini API) " +
        "or AI_INTEGRATIONS_GEMINI_API_KEY + AI_INTEGRATIONS_GEMINI_BASE_URL (Replit AI integration).",
    );
  }
  client = new GoogleGenAI({
    apiKey: creds.apiKey,
    ...(creds.baseUrl
      ? { httpOptions: { apiVersion: "", baseUrl: creds.baseUrl } }
      : {}),
  });
  return client;
}

// Preserves the existing `ai.models.generateContent(...)` call surface for all
// consumers while deferring construction until first property access.
export const ai: GoogleGenAI = new Proxy({} as GoogleGenAI, {
  get(_target, prop, receiver) {
    const instance = getClient();
    const value = Reflect.get(instance as object, prop, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
