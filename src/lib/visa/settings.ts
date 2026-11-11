// What the owner keeps for the visa module (ADR 0012): passports held (with an optional
// expiry, for the passport-validity check), the legal-residency country to keep, and the
// countries to watch for tax days. Stored server-side in "visa.json" (owner-only).

export interface PassportHeld {
  /** ISO-2 code of the issuing country. */
  country: string;
  /** Expiry date, YYYY-MM-DD; optional. */
  expires?: string;
}

export interface VisaSettings {
  passports: PassportHeld[];
  /** ISO-2 code of the country the owner is legally resident in and wants to keep, or null. */
  residency: string | null;
  /** ISO-2 codes listed on the tax counters even with no days yet. */
  taxWatch: string[];
  updatedAt?: string;
}

export const DEFAULT_VISA_SETTINGS: VisaSettings = { passports: [], residency: null, taxWatch: [] };

export const passportCodes = (s: Pick<VisaSettings, "passports"> | null | undefined): string[] => (s?.passports ?? []).map((p) => p.country);

export const expiryByPassport = (s: Pick<VisaSettings, "passports"> | null | undefined): Record<string, string | undefined> =>
  Object.fromEntries((s?.passports ?? []).map((p) => [p.country, p.expires]));
