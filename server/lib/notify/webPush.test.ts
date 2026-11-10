import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPublicKey, generateKeyPairSync, verify } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MAX_PUSH_SUBSCRIPTIONS,
  PushGoneError,
  encryptPushPayload,
  listPushSubscriptions,
  removePushSubscription,
  savePushSubscription,
  sendPush,
  vapidAuthorization,
  vapidConfig,
} from "./webPush";

const b = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "base64url");

// RFC 8291 Appendix A.
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

function vapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  return { publicKey: pub.toString("base64url"), privateKey: privateKey.export({ format: "jwk" }).d!, subject: "mailto:owner@example.com" };
}

describe("encryptPushPayload", () => {
  it("reproduces the RFC 8291 Appendix A message byte for byte", () => {
    const out = encryptPushPayload(b(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { salt: b(RFC.salt), serverPrivateKey: b(RFC.asPrivate) });
    expect(out.subarray(0, 86).toString("base64url")).toBe(RFC.header);
    expect(out.subarray(86).toString("base64url")).toBe(RFC.ciphertext);
  });

  it("uses a fresh salt and key per message", () => {
    const keys = { p256dh: RFC.uaPublic, auth: RFC.auth };
    expect(encryptPushPayload(Buffer.from("x"), keys).equals(encryptPushPayload(Buffer.from("x"), keys))).toBe(false);
  });

  it("rejects malformed keys and oversized payloads", () => {
    expect(() => encryptPushPayload(Buffer.from("x"), { p256dh: "AAAA", auth: RFC.auth })).toThrow(/P-256/);
    expect(() => encryptPushPayload(Buffer.from("x"), { p256dh: RFC.uaPublic, auth: "AAAA" })).toThrow(/16 bytes/);
    expect(() => encryptPushPayload(Buffer.alloc(5000), { p256dh: RFC.uaPublic, auth: RFC.auth })).toThrow(/too large/);
  });
});

describe("VAPID", () => {
  it("reports what is missing", () => {
    expect(vapidConfig({})).toEqual({ missing: expect.stringContaining("VAPID_PUBLIC_KEY") });
    const k = vapidKeys();
    expect(vapidConfig({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey })).toEqual({ missing: expect.stringContaining("VAPID_SUBJECT") });
    expect(vapidConfig({ VAPID_PUBLIC_KEY: "abc", VAPID_PRIVATE_KEY: "def", VAPID_SUBJECT: "mailto:a@b.c" })).toHaveProperty("missing");
    expect(vapidConfig({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: k.subject })).toEqual(k);
  });

  it("signs an ES256 JWT for the endpoint's origin that verifies with the public key", () => {
    const k = vapidKeys();
    const now = new Date("2026-11-10T00:00:00Z");
    const header = vapidAuthorization("https://push.example/send/abc", k, now);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)!;
    expect(m[4]).toBe(k.publicKey);
    expect(JSON.parse(Buffer.from(m[1], "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(Buffer.from(m[2], "base64url").toString())).toEqual({
      aud: "https://push.example",
      exp: now.getTime() / 1000 + 12 * 3600,
      sub: k.subject,
    });
    const pub = Buffer.from(k.publicKey, "base64url");
    const key = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") },
      format: "jwk",
    });
    expect(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url"))).toBe(true);
  });
});

describe("sendPush", () => {
  const sub = { endpoint: "https://push.example/send/abc", keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };

  it("POSTs an aes128gcm body with VAPID and TTL headers", async () => {
    const calls: [string, RequestInit][] = [];
    await sendPush(sub, "hello", vapidKeys(), (async (u: string, i: RequestInit) => {
      calls.push([u, i]);
      return new Response(null, { status: 201 });
    }) as never);
    const [url, init] = calls[0];
    expect(url).toBe(sub.endpoint);
    const h = init.headers as Record<string, string>;
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(h.TTL).toBe("86400");
    expect(h.Authorization).toMatch(/^vapid t=/);
    // 86-byte header + "hello" + delimiter + 16-byte tag
    expect((init.body as Uint8Array).length).toBe(86 + 5 + 1 + 16);
  });

  it("maps 404/410 to PushGoneError and other failures to an Error", async () => {
    const k = vapidKeys();
    await expect(sendPush(sub, "x", k, (async () => new Response(null, { status: 410 })) as never)).rejects.toBeInstanceOf(PushGoneError);
    await expect(sendPush(sub, "x", k, (async () => new Response(null, { status: 500 })) as never)).rejects.toThrow(/500/);
  });
});

describe("subscriptions", () => {
  let TMP: string;
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "meridian-push-"));
    process.env.DATA_DIR = TMP;
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });
  const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: RFC.uaPublic, auth: RFC.auth } });

  it("saves idempotently by endpoint, removes, and caps the list", async () => {
    await savePushSubscription(sub(1));
    await savePushSubscription(sub(1));
    expect(await listPushSubscriptions()).toHaveLength(1);
    expect(await removePushSubscription(sub(1).endpoint)).toBe(true);
    expect(await removePushSubscription(sub(1).endpoint)).toBe(false);
    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS + 2; i++) await savePushSubscription(sub(i));
    const all = await listPushSubscriptions();
    expect(all).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
    expect(all[0].endpoint).toBe("https://push.example/2");
  });

  it("rejects non-https endpoints and malformed keys", async () => {
    await expect(savePushSubscription({ endpoint: "http://push.example/1", keys: sub(1).keys })).rejects.toThrow();
    await expect(savePushSubscription({ endpoint: "https://push.example/1", keys: { p256dh: "x", auth: "y" } })).rejects.toThrow();
  });
});
