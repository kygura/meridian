import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "net";
import type { AddressInfo } from "net";
import { bareAddress, buildMessage, parseSmtpUrl, sendMail } from "./smtp";

describe("parseSmtpUrl", () => {
  it("reads scheme, default ports and percent-encoded credentials", () => {
    expect(parseSmtpUrl("smtps://me%40example.com:p%40ss@smtp.example.com")).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "me@example.com",
      pass: "p@ss",
    });
    expect(parseSmtpUrl("smtp://smtp.example.com")).toEqual({ host: "smtp.example.com", port: 587, secure: false, user: undefined, pass: undefined });
    expect(parseSmtpUrl("smtp://u:p@h:2525").port).toBe(2525);
    expect(() => parseSmtpUrl("http://x")).toThrow(/smtp/);
    expect(() => parseSmtpUrl("nonsense")).toThrow();
  });
});

describe("buildMessage", () => {
  it("writes headers, encodes a non-ASCII subject and base64s the body", () => {
    const raw = buildMessage({ from: "Meridian <m@example.com>", to: ["a@example.com"], subject: "Kraków at 80 EUR", text: "Line one\nLine two" }, new Date("2026-11-10T06:17:00Z"));
    expect(raw).toContain("From: Meridian <m@example.com>\r\n");
    expect(raw).toContain("To: a@example.com\r\n");
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("Kraków at 80 EUR").toString("base64")}?=\r\n`);
    expect(raw).toContain("Date: Tue, 10 Nov 2026 06:17:00 +0000\r\n");
    expect(raw).toMatch(/Message-ID: <[\w-]+@example\.com>\r\n/);
    const body = raw.split("\r\n\r\n")[1];
    expect(Buffer.from(body, "base64").toString()).toBe("Line one\r\nLine two");
  });

  it("cannot be made to inject a header through the subject", () => {
    const raw = buildMessage({ from: "m@example.com", to: ["a@example.com"], subject: "Hi\r\nBcc: evil@example.com", text: "x" });
    expect(raw).not.toMatch(/\r\nBcc:/);
  });

  it("bareAddress strips a display name", () => {
    expect(bareAddress("Meridian <m@example.com>")).toBe("m@example.com");
    expect(bareAddress(" m@example.com ")).toBe("m@example.com");
  });
});

// A scripted plain-text SMTP server on localhost (where the client allows no STARTTLS).
describe("sendMail", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  function fakeServer(opts: { rejectAuth?: boolean; silent?: boolean } = {}): Promise<{ port: number; lines: string[]; data: () => string }> {
    const lines: string[] = [];
    let data = "";
    return new Promise((resolve) => {
      server = createServer((sock: Socket) => {
        let inData = false;
        let buf = "";
        if (!opts.silent) sock.write("220 fake ESMTP\r\n");
        sock.on("data", (d) => {
          buf += d.toString();
          let i: number;
          while ((i = buf.indexOf("\r\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (inData) {
              if (line === ".") {
                inData = false;
                sock.write("250 queued\r\n");
              } else data += line + "\r\n";
              continue;
            }
            lines.push(line);
            if (line.startsWith("EHLO")) sock.write("250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1000000\r\n");
            else if (line.startsWith("AUTH")) sock.write(opts.rejectAuth ? "535 5.7.8 bad credentials\r\n" : "235 ok\r\n");
            else if (line.startsWith("MAIL") || line.startsWith("RCPT")) sock.write("250 ok\r\n");
            else if (line === "DATA") {
              inData = true;
              sock.write("354 go\r\n");
            } else if (line === "QUIT") sock.end("221 bye\r\n");
          }
        });
        sock.on("error", () => undefined);
      });
      server.listen(0, "127.0.0.1", () => resolve({ port: (server!.address() as AddressInfo).port, lines, data: () => data }));
    });
  }

  const msg = { from: "Meridian <m@example.com>", to: ["a@example.com", "b@example.com"], subject: "Hello", text: "Body\n.leading dot" };

  it("runs EHLO, AUTH PLAIN, MAIL, RCPT per recipient, DATA with dot-stuffing", async () => {
    const s = await fakeServer();
    await sendMail({ host: "127.0.0.1", port: s.port, secure: false, user: "u", pass: "p" }, msg);
    expect(s.lines[0]).toMatch(/^EHLO /);
    expect(s.lines[1]).toBe(`AUTH PLAIN ${Buffer.from("\0u\0p").toString("base64")}`);
    expect(s.lines.slice(2, 6)).toEqual(["MAIL FROM:<m@example.com>", "RCPT TO:<a@example.com>", "RCPT TO:<b@example.com>", "DATA"]);
    expect(s.data()).toContain("Subject: Hello\r\n");
    const body = s.data().split("\r\n\r\n")[1].trim();
    expect(Buffer.from(body, "base64").toString()).toBe("Body\r\n.leading dot");
  });

  it("fails with the server's reason on rejected credentials, without echoing them", async () => {
    const s = await fakeServer({ rejectAuth: true });
    const err = await sendMail({ host: "127.0.0.1", port: s.port, secure: false, user: "u", pass: "hunter2" }, msg).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/SMTP AUTH failed: 535/);
    expect((err as Error).message).not.toContain(Buffer.from("\0u\0hunter2").toString("base64"));
  });

  it("times out on a server that never greets", async () => {
    const s = await fakeServer({ silent: true });
    await expect(sendMail({ host: "127.0.0.1", port: s.port, secure: false }, msg, { timeoutMs: 80 })).rejects.toThrow("SMTP timed out");
  });

  it("refuses addresses that could smuggle commands", async () => {
    await expect(sendMail({ host: "127.0.0.1", port: 1, secure: false }, { ...msg, to: ["a@example.com>\r\nRCPT TO:<x@y.z"] })).rejects.toThrow("not an email address");
  });
});
