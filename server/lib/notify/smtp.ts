// Minimal SMTP submission client for alert email: one plain-text message per
// connection, no library. Enough for a mailbox provider's submission endpoint.
//
//   SMTP_URL=smtps://user:pass@smtp.example.com:465   implicit TLS
//   SMTP_URL=smtp://user:pass@smtp.example.com:587    STARTTLS (required)
//
// Credentials are percent-decoded from the URL. On smtp:// the session must upgrade
// with STARTTLS before AUTH; a server that doesn't offer it is refused, except on
// localhost (tests, a local relay) where plain is allowed.

import { connect as netConnect, type Socket } from "net";
import { connect as tlsConnect } from "tls";
import { hostname } from "os";
import { randomUUID } from "crypto";

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = implicit TLS (smtps://). */
  secure: boolean;
  user?: string;
  pass?: string;
}

export interface MailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

export function parseSmtpUrl(raw: string): SmtpConfig {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("SMTP_URL is not a URL");
  }
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error("SMTP_URL must start with smtp:// or smtps://");
  const secure = u.protocol === "smtps:";
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : secure ? 465 : 587,
    secure,
    user: u.username ? decodeURIComponent(u.username) : undefined,
    pass: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

/** "Name <a@b.c>" → "a@b.c". */
export function bareAddress(addr: string): string {
  const m = /<([^<>]+)>\s*$/.exec(addr);
  return (m ? m[1] : addr).trim();
}

const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
/** Header values must not carry line breaks (header injection). */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

/** RFC 5322 message with a base64 UTF-8 body. */
export function buildMessage(msg: MailMessage, now = new Date()): string {
  const domain = bareAddress(msg.from).split("@")[1] ?? "localhost";
  const body = Buffer.from(msg.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `From: ${oneLine(msg.from)}`,
    `To: ${msg.to.map(oneLine).join(", ")}`,
    `Subject: ${encodeHeader(oneLine(msg.subject))}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
    "",
  ].join("\r\n");
}

interface Reply {
  code: number;
  lines: string[];
}

/** Reads SMTP replies (possibly multi-line) off a socket, one at a time. */
class Session {
  private buf = "";
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private failed: Error | null = null;
  private lines: string[] = [];
  private readonly onData = (d: Buffer) => {
    this.buf += d.toString("utf8");
    this.drain();
  };
  private readonly onError = (e: Error) => this.fail(e);
  private readonly onClose = () => this.fail(new Error("SMTP connection closed"));

  constructor(public socket: Socket) {
    this.attach(socket);
  }

  private attach(socket: Socket) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  /** Swap in the TLS socket after STARTTLS. */
  replace(socket: Socket) {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    this.socket = socket;
    this.buf = "";
    this.attach(socket);
  }

  private fail(e: Error) {
    this.failed ??= e;
    this.waiting?.reject(this.failed);
    this.waiting = null;
  }

  private drain() {
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      // "250-..." continues, "250 ..." ends the reply.
      if (/^\d{3}( |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.lines };
        this.lines = [];
        if (this.waiting) {
          const w = this.waiting;
          this.waiting = null;
          w.resolve(reply);
        } else {
          this.pending.push(reply);
        }
      }
    }
  }
  private pending: Reply[] = [];

  read(): Promise<Reply> {
    const ready = this.pending.shift();
    if (ready) return Promise.resolve(ready);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  /** Send a command and require a reply code; `label` hides secrets from error text. */
  async cmd(line: string, expect: number | number[], label = line): Promise<Reply> {
    this.socket.write(`${line}\r\n`);
    return this.expect(await this.read(), expect, label);
  }

  expect(reply: Reply, expect: number | number[], label: string): Reply {
    const ok = Array.isArray(expect) ? expect.includes(reply.code) : reply.code === expect;
    if (!ok) throw new Error(`SMTP ${label.split(" ")[0]} failed: ${reply.lines.join(" ").slice(0, 200)}`);
    return reply;
  }
}

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";

/** Send one message. Rejects on any protocol, TLS, auth or timeout failure. */
export async function sendMail(cfg: SmtpConfig, msg: MailMessage, opts: { timeoutMs?: number; now?: Date } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  for (const a of [msg.from, ...msg.to]) {
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(bareAddress(a))) throw new Error("SMTP: not an email address");
  }
  if (msg.to.length === 0) throw new Error("SMTP: no recipient");
  const socket: Socket = cfg.secure
    ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host })
    : netConnect({ host: cfg.host, port: cfg.port });
  const session = new Session(socket);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("SMTP timed out")), timeoutMs);
  });

  const run = async () => {
    const name = hostname() || "localhost";
    session.expect(await session.read(), 220, "greeting");
    let ehlo = await session.cmd(`EHLO ${name}`, 250);
    const offers = (r: Reply, ext: string) => r.lines.some((l) => l.slice(4).toUpperCase().startsWith(ext));

    if (!cfg.secure) {
      if (offers(ehlo, "STARTTLS")) {
        await session.cmd("STARTTLS", 220);
        const secured = tlsConnect({ socket: session.socket, servername: cfg.host });
        session.replace(secured);
        await new Promise<void>((resolve, reject) => {
          secured.once("secureConnect", resolve);
          secured.once("error", reject);
        });
        ehlo = await session.cmd(`EHLO ${name}`, 250);
      } else if (!isLocal(cfg.host)) {
        throw new Error("SMTP server does not offer STARTTLS; refusing to send credentials in the clear");
      }
    }

    if (cfg.user !== undefined) {
      const token = Buffer.from(`\0${cfg.user}\0${cfg.pass ?? ""}`, "utf8").toString("base64");
      await session.cmd(`AUTH PLAIN ${token}`, 235, "AUTH PLAIN");
    }
    await session.cmd(`MAIL FROM:<${bareAddress(msg.from)}>`, 250);
    for (const to of msg.to) await session.cmd(`RCPT TO:<${bareAddress(to)}>`, [250, 251]);
    await session.cmd("DATA", 354);
    // Dot-stuffing: a line that starts with "." gets a second one.
    const data = buildMessage(msg, opts.now).replace(/^\./gm, "..");
    await session.cmd(`${data}\r\n.`, 250, "DATA body");
    session.socket.write("QUIT\r\n");
  };

  try {
    await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
    session.socket.destroy();
  }
}
