// Prints a fresh VAPID key pair for Web Push (ADR 0016). Nothing is written to disk.
//
//   node scripts/generate-vapid.mjs
//
// Put the two lines in .env (or your host's environment) and add VAPID_SUBJECT yourself:
// a mailto: address or an https URL the push service can contact about this sender.
// Changing the keys later invalidates every device's subscription (subscribe again in
// Settings › Alerts).

import { generateKeyPairSync } from "crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pub = publicKey.export({ format: "jwk" });
const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);

console.log(`VAPID_PUBLIC_KEY=${point.toString("base64url")}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey.export({ format: "jwk" }).d}`);
