// Web Push without a library: message encryption (RFC 8291, aes128gcm), VAPID
// (RFC 8292) and the stored subscriptions. Checked against the RFC 8291 Appendix A
// vector in webPush.test.ts.
//
// Keys come from the environment (generate with `node scripts/generate-vapid.mjs`):
//   VAPID_PUBLIC_KEY   base64url, 65-byte uncompressed P-256 point
//   VAPID_PRIVATE_KEY  base64url, 32-byte scalar
//   VAPID_SUBJECT      "mailto:you@example.com" or an https URL; push services may
//                      contact it about a misbehaving sender. Sent to the push service.

import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from "crypto";
import { z } from "zod";
import { createJsonStore } from "../jsonStore.js";

export const MAX_PUSH_SUBSCRIPTIONS = 20;
const RECORD_SIZE = 4096;
/** One record only: payload + 1 delimiter byte + 16-byte tag must fit in a record. */
export const MAX_PUSH_PAYLOAD = RECORD_SIZE - 17;

const b64u = (b: Buffer) => b.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

// ── subscriptions ───────────────────────────────────────────────────

export const pushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2000)
    .refine((u) => u.startsWith("https://"), "endpoint must be https"),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{86,88}=?$/, "p256dh must be a base64url P-256 point"),
    auth: z.string().regex(/^[A-Za-z0-9_-]{21,24}={0,2}$/, "auth must be a base64url 16-byte secret"),
  }),
});

export interface StoredPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}

interface SubscriptionsFile {
  version: 1;
  subscriptions: StoredPushSubscription[];
}
const store = createJsonStore<SubscriptionsFile>("push-subscriptions.json", () => ({ version: 1, subscriptions: [] }));

export async function listPushSubscriptions(): Promise<StoredPushSubscription[]> {
  return (await store.read()).subscriptions;
}

/** Idempotent by endpoint. Past the cap the oldest subscription is dropped. Throws ZodError on bad input. */
export async function savePushSubscription(raw: unknown, now = new Date()): Promise<StoredPushSubscription> {
  const input = pushSubscriptionSchema.parse(raw);
  const sub: StoredPushSubscription = { endpoint: input.endpoint, keys: input.keys, createdAt: now.toISOString() };
  await store.update((f) => {
    f.subscriptions = f.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    f.subscriptions.push(sub);
    if (f.subscriptions.length > MAX_PUSH_SUBSCRIPTIONS) f.subscriptions = f.subscriptions.slice(-MAX_PUSH_SUBSCRIPTIONS);
  });
  return sub;
}

export async function removePushSubscription(endpoint: string): Promise<boolean> {
  return store.update((f) => {
    const n = f.subscriptions.length;
    f.subscriptions = f.subscriptions.filter((s) => s.endpoint !== endpoint);
    return f.subscriptions.length < n;
  });
}

// ── VAPID ───────────────────────────────────────────────────────────

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** The configured keys, or the reason push is off. */
export function vapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig | { missing: string } {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey) return { missing: "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY" };
  if (!subject || !/^(mailto:|https:\/\/)/.test(subject)) return { missing: "VAPID_SUBJECT (mailto: or https:)" };
  if (unb64u(publicKey).length !== 65 || unb64u(privateKey).length !== 32) return { missing: "valid VAPID keys (run scripts/generate-vapid.mjs)" };
  return { publicKey, privateKey, subject };
}

/** "vapid t=<jwt>, k=<public key>" for the push service at `endpoint`. */
export function vapidAuthorization(endpoint: string, vapid: VapidConfig, now = new Date()): string {
  const pub = unb64u(vapid.publicKey);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: vapid.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(
    Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: vapid.subject }))
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
}

// ── encryption ──────────────────────────────────────────────────────

/**
 * Encrypt one push message body (RFC 8291 §3.4 + RFC 8188 header). `salt` and
 * `serverPrivateKey` are random per message; tests pass the RFC's fixed values.
 */
export function encryptPushPayload(
  payload: Buffer,
  keys: { p256dh: string; auth: string },
  opts: { salt?: Buffer; serverPrivateKey?: Buffer } = {}
): Buffer {
  if (payload.length > MAX_PUSH_PAYLOAD) throw new Error(`push payload too large (${payload.length} > ${MAX_PUSH_PAYLOAD})`);
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh is not an uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("auth secret must be 16 bytes");

  const ecdh = createECDH("prime256v1");
  if (opts.serverPrivateKey) ecdh.setPrivateKey(opts.serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);

  const one = Buffer.from([1]);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, one]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), one])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), one])).subarray(0, 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 = padding delimiter of the last (only) record.
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

export class PushGoneError extends Error {}

/** POST one encrypted message. Throws PushGoneError when the subscription no longer exists (404/410). */
export async function sendPush(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  vapid: VapidConfig,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<void> {
  const body = encryptPushPayload(Buffer.from(payload, "utf8"), sub.keys);
  const res = await fetchImpl(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(24 * 3600),
      Urgency: "normal",
      Authorization: vapidAuthorization(sub.endpoint, vapid),
    },
    body: new Uint8Array(body),
    signal,
  });
  if (res.status === 404 || res.status === 410) throw new PushGoneError(`subscription gone (${res.status})`);
  if (!res.ok) throw new Error(`push service responded ${res.status}`);
}
