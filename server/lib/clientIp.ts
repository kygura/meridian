// The client address used as the key for rate limits and the login lockout.
//
// A forwarded header is only believed when the deployment says a proxy sets it:
//   - Vercel overwrites x-real-ip / x-forwarded-for itself, so they are trusted there.
//   - TRUST_PROXY=<n> trusts n proxy hops: the nth entry from the right of
//     X-Forwarded-For is the address the outermost trusted proxy saw.
//   - Otherwise the socket address is used. Behind an undeclared proxy every client
//     then shares one bucket, which is stricter, never looser.

import type { Context } from "hono";

function socketAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? undefined;
}

function trustedHops(): number {
  const raw = process.env.TRUST_PROXY?.trim();
  if (raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? Math.min(n, 10) : 0;
  }
  return process.env.VERCEL ? 1 : 0;
}

export function clientIp(c: Context): string {
  const hops = trustedHops();
  if (hops > 0) {
    if (process.env.VERCEL) {
      const real = c.req.header("x-real-ip")?.trim();
      if (real) return real;
    }
    const chain = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const picked = chain[chain.length - hops] ?? chain[0];
    if (picked) return picked;
  }
  return socketAddress(c) ?? "unknown";
}
