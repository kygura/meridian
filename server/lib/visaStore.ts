// Visa settings (ADR 0012): one "visa.json" document in the shared store (a file under
// DATA_DIR, or a Postgres row), so both backends work. Personal: owner-only routes read it.

import { z } from "zod";
import { createJsonStore } from "./jsonStore.js";
import { isoDateSchema } from "./journalSchemas.js";
import { DEFAULT_VISA_SETTINGS, type VisaSettings } from "../../src/lib/visa/settings.js";
import { getVisaData } from "./visaData.js";

const code = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .refine((c) => !getVisaData() || !!getVisaData()!.countries[c], { message: "unknown country code" });

export const visaSettingsSchema = z.object({
  passports: z.array(z.object({ country: code, expires: isoDateSchema.optional() })).max(5),
  residency: code.nullable(),
  taxWatch: z.array(code).max(20),
});

interface VisaDoc {
  version: 1;
  settings: VisaSettings;
}

const store = createJsonStore<VisaDoc>("visa.json", () => ({ version: 1, settings: { ...DEFAULT_VISA_SETTINGS } }));

export async function getVisaSettings(): Promise<VisaSettings> {
  return { ...DEFAULT_VISA_SETTINGS, ...(await store.read()).settings };
}

export async function putVisaSettings(input: z.infer<typeof visaSettingsSchema>, now = new Date()): Promise<VisaSettings> {
  return store.update((doc) => {
    // One entry per passport country; the residency is not also a watched country.
    const seen = new Set<string>();
    const passports = input.passports.filter((p) => !seen.has(p.country) && seen.add(p.country));
    doc.settings = { passports, residency: input.residency, taxWatch: [...new Set(input.taxWatch)].filter((c) => c !== input.residency), updatedAt: now.toISOString() };
    return doc.settings;
  });
}
