/**
 * GCC / MENA country localization profiles.
 *
 * The selected country drives placeholders, examples, and phone-validation
 * GUIDANCE only — it never modifies saved data. Each profile carries both an
 * English and an Arabic example so placeholders follow the active app language.
 *
 * Adding a country later is a single entry here — no other code changes.
 */

export type CountryCode =
  | "SA"
  | "AE"
  | "QA"
  | "OM"
  | "KW"
  | "BH"
  | "EG"
  | "MA";

export interface CountryProfile {
  code: CountryCode;
  /** International dialing prefix, e.g. "+966". */
  dialCode: string;
  /** Flag emoji for display. */
  flag: string;
  /** Display name in English / Arabic. */
  nameEn: string;
  nameAr: string;
  /** Phone example/placeholder, e.g. "+966 5X XXX XXXX". */
  phoneExample: string;
  /** Capital / sample city in English / Arabic. */
  cityEn: string;
  cityAr: string;
  /** Sample street address in English / Arabic. */
  addressEn: string;
  addressAr: string;
  /**
   * Expected number of national digits AFTER the dial code (used as a soft
   * length hint when a number is entered in the local format). Validation still
   * accepts any valid international number.
   */
  nationalDigits: number;
}

export const COUNTRIES: Record<CountryCode, CountryProfile> = {
  SA: {
    code: "SA",
    dialCode: "+966",
    flag: "🇸🇦",
    nameEn: "Saudi Arabia",
    nameAr: "المملكة العربية السعودية",
    phoneExample: "+966 5X XXX XXXX",
    cityEn: "Riyadh",
    cityAr: "الرياض",
    addressEn: "King Fahd Road, Riyadh, Saudi Arabia",
    addressAr: "طريق الملك فهد، الرياض، المملكة العربية السعودية",
    nationalDigits: 9,
  },
  AE: {
    code: "AE",
    dialCode: "+971",
    flag: "🇦🇪",
    nameEn: "United Arab Emirates",
    nameAr: "الإمارات العربية المتحدة",
    phoneExample: "+971 5X XXX XXXX",
    cityEn: "Dubai",
    cityAr: "دبي",
    addressEn: "Sheikh Zayed Road, Dubai, UAE",
    addressAr: "شارع الشيخ زايد، دبي، الإمارات",
    nationalDigits: 9,
  },
  QA: {
    code: "QA",
    dialCode: "+974",
    flag: "🇶🇦",
    nameEn: "Qatar",
    nameAr: "قطر",
    phoneExample: "+974 XXXX XXXX",
    cityEn: "Doha",
    cityAr: "الدوحة",
    addressEn: "Al Corniche Street, Doha, Qatar",
    addressAr: "شارع الكورنيش، الدوحة، قطر",
    nationalDigits: 8,
  },
  OM: {
    code: "OM",
    dialCode: "+968",
    flag: "🇴🇲",
    nameEn: "Oman",
    nameAr: "عُمان",
    phoneExample: "+968 XXXX XXXX",
    cityEn: "Muscat",
    cityAr: "مسقط",
    addressEn: "Sultan Qaboos Street, Muscat, Oman",
    addressAr: "شارع السلطان قابوس، مسقط، عُمان",
    nationalDigits: 8,
  },
  KW: {
    code: "KW",
    dialCode: "+965",
    flag: "🇰🇼",
    nameEn: "Kuwait",
    nameAr: "الكويت",
    phoneExample: "+965 XXXX XXXX",
    cityEn: "Kuwait City",
    cityAr: "مدينة الكويت",
    addressEn: "Arabian Gulf Street, Kuwait City, Kuwait",
    addressAr: "شارع الخليج العربي، مدينة الكويت، الكويت",
    nationalDigits: 8,
  },
  BH: {
    code: "BH",
    dialCode: "+973",
    flag: "🇧🇭",
    nameEn: "Bahrain",
    nameAr: "البحرين",
    phoneExample: "+973 XXXX XXXX",
    cityEn: "Manama",
    cityAr: "المنامة",
    addressEn: "King Faisal Highway, Manama, Bahrain",
    addressAr: "طريق الملك فيصل، المنامة، البحرين",
    nationalDigits: 8,
  },
  EG: {
    code: "EG",
    dialCode: "+20",
    flag: "🇪🇬",
    nameEn: "Egypt",
    nameAr: "مصر",
    phoneExample: "+20 1X XXX XXXX",
    cityEn: "Cairo",
    cityAr: "القاهرة",
    addressEn: "Tahrir Square, Cairo, Egypt",
    addressAr: "ميدان التحرير، القاهرة، مصر",
    nationalDigits: 10,
  },
  MA: {
    code: "MA",
    dialCode: "+212",
    flag: "🇲🇦",
    nameEn: "Morocco",
    nameAr: "المغرب",
    phoneExample: "+212 6XX XXX XXX",
    cityEn: "Casablanca",
    cityAr: "الدار البيضاء",
    addressEn: "Boulevard Mohammed V, Casablanca, Morocco",
    addressAr: "شارع محمد الخامس، الدار البيضاء، المغرب",
    nationalDigits: 9,
  },
};

export const DEFAULT_COUNTRY: CountryCode = "SA";

/** Ordered list for pickers — KSA first, then the rest. */
export const COUNTRY_ORDER: CountryCode[] = [
  "SA",
  "AE",
  "QA",
  "OM",
  "KW",
  "BH",
  "EG",
  "MA",
];

export function getCountry(code: CountryCode | null | undefined): CountryProfile {
  return (code && COUNTRIES[code]) || COUNTRIES[DEFAULT_COUNTRY];
}

export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === "string" && value in COUNTRIES;
}

/** Localized display name for a country. */
export function countryName(code: CountryCode, lang: string): string {
  const c = getCountry(code);
  return lang === "ar" ? c.nameAr : c.nameEn;
}

/** Localized city example. */
export function cityExample(code: CountryCode, lang: string): string {
  const c = getCountry(code);
  return lang === "ar" ? c.cityAr : c.cityEn;
}

/** Localized address example. */
export function addressExample(code: CountryCode, lang: string): string {
  const c = getCountry(code);
  return lang === "ar" ? c.addressAr : c.addressEn;
}

/** Phone placeholder/example (always international format, language-agnostic). */
export function phoneExample(code: CountryCode): string {
  return getCountry(code).phoneExample;
}

export interface PhoneValidationResult {
  valid: boolean;
  /** Country-specific guidance, e.g. the expected example format. */
  hint: string;
}

/**
 * Validate a phone number. Accepts ANY valid international number (E.164-style)
 * so cards from other regions still pass — the selected country only shapes the
 * GUIDANCE/example shown to the user. Empty input is treated as valid (optional
 * field); callers requiring a value should check non-empty separately.
 */
export function validatePhone(
  raw: string,
  code: CountryCode,
): PhoneValidationResult {
  const profile = getCountry(code);
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { valid: true, hint: profile.phoneExample };

  // Strip spaces, dashes, dots, parentheses for validation.
  const cleaned = trimmed.replace(/[\s\-.()]/g, "");
  // International E.164: optional +, leading non-zero, 7–15 digits total.
  // Also accept a leading 0 for purely-local entry (e.g. 05X...).
  const intl = /^\+?[1-9]\d{6,14}$/;
  const local = /^0\d{6,14}$/;
  const valid = intl.test(cleaned) || local.test(cleaned);
  return { valid, hint: profile.phoneExample };
}
