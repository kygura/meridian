// Encrypts the Google refresh token at rest (AES-256-GCM). The key comes from the
// environment (GMAIL_TOKEN_KEY), never from the document store, so a copy of the store
// alone, a backup or a database dump, does not give access to the mailbox.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";

const MIN_KEY_CHARS = 32;

export function tokenKeyConfigured(): boolean {
  return (process.env.GMAIL_TOKEN_KEY?.length ?? 0) >= MIN_KEY_CHARS;
}

/** A 32-byte key derived from the env value, so any long random string works (`openssl rand -hex 32`). */
function key(): Buffer {
  const raw = process.env.GMAIL_TOKEN_KEY ?? "";
  if (raw.length < MIN_KEY_CHARS) throw new Error("GMAIL_TOKEN_KEY must be at least 32 characters");
  return Buffer.from(hkdfSync("sha256", raw, "meridian-gmail", "refresh-token-v1", 32));
}

const b64 = (b: Buffer) => b.toString("base64url");

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${b64(iv)}.${b64(c.getAuthTag())}.${b64(ct)}`;
}

/** Throws when the key is wrong or the value was altered. */
export function decryptToken(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("unrecognised token format");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
