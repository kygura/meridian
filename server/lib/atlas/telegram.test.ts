import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_CHARS, buildExecutionContext, buildRoutineRequest, clipMessage, modeForCommand, parseTelegramCommand } from "./telegram";

describe("parseTelegramCommand", () => {
  it("returns null for free text", () => {
    expect(parseTelegramCommand("find me a surf trip")).toBeNull();
  });

  it("returns null for unrecognized commands", () => {
    expect(parseTelegramCommand("/unknown foo:bar")).toBeNull();
  });

  it("parses /help and /start as help, and strips an @botname suffix", () => {
    const help = parseTelegramCommand("/help");
    expect(help?.name).toBe("help");
    expect(help?.raw_args).toBeNull();
    expect(parseTelegramCommand("/start")?.name).toBe("help");
    expect(parseTelegramCommand("/help@AtlasBot")?.name).toBe("help");
  });

  it("parses a bare /scout with no arguments", () => {
    const parsed = parseTelegramCommand("/scout");
    expect(parsed?.name).toBe("scout");
    expect(parsed?.raw_args).toBeNull();
    expect(parsed?.destination_focus).toEqual([]);
    expect(parsed?.activity_types).toEqual([]);
  });

  it("accepts /trip, /plan and /search as aliases", () => {
    for (const name of ["trip", "plan", "search"]) expect(parseTelegramCommand(`/${name} destination:Bali`)?.name).toBe(name);
  });

  it("parses destination, activity, days, budget and origin", () => {
    const parsed = parseTelegramCommand("/scout destination:Portugal activity:surf,relax days:7-10 budget:800-1500 origin:MAD");
    expect(parsed?.destination_focus).toEqual(["Portugal"]);
    expect(parsed?.activity_types).toEqual(["surf", "relax"]);
    expect(parsed?.stay_duration_days).toEqual({ min: 7, max: 10 });
    expect(parsed?.budget_range_eur).toEqual({ min: 800, max: 1500 });
    expect(parsed?.origin).toBe("MAD");
    expect(parsed?.preferred_origins).toEqual(["MAD"]);
  });

  it("supports the key aliases to, type, nights, price and from", () => {
    const parsed = parseTelegramCommand("/scout to:Lombok type:surf nights:5 price:1000 from:agp");
    expect(parsed?.destination_focus).toEqual(["Lombok"]);
    expect(parsed?.activity_types).toEqual(["surf"]);
    expect(parsed?.stay_duration_days).toEqual({ min: null, max: 5 });
    expect(parsed?.budget_range_eur).toEqual({ min: null, max: 1000 });
    expect(parsed?.origin).toBe("AGP");
  });

  it("handles the budget comparison syntax", () => {
    expect(parseTelegramCommand("/scout budget:<1500")?.budget_range_eur).toEqual({ min: null, max: 1500 });
    expect(parseTelegramCommand("/scout budget:800+")?.budget_range_eur).toEqual({ min: 800, max: null });
    expect(parseTelegramCommand("/scout budget:1200")?.budget_range_eur).toEqual({ min: null, max: 1200 });
    expect(parseTelegramCommand("/scout budget:1500-800")?.budget_range_eur).toEqual({ min: 800, max: 1500 });
  });

  it("keeps unrecognized tokens as notes", () => {
    expect(parseTelegramCommand("/scout destination:Bali quiet no-nightlife")?.notes).toEqual(["quiet", "no-nightlife"]);
  });

  it("routes a non-IATA origin to the notes", () => {
    const parsed = parseTelegramCommand("/scout origin:Lisbon");
    expect(parsed?.origin).toBeNull();
    expect(parsed?.preferred_origins).toEqual([]);
    expect(parsed?.notes).toEqual(["origin: Lisbon"]);
  });

  it("does not set a single origin for several codes", () => {
    const parsed = parseTelegramCommand("/scout origin:MAD,AGP");
    expect(parsed?.preferred_origins).toEqual(["MAD", "AGP"]);
    expect(parsed?.origin).toBeNull();
  });

  it("accepts /discover and its aliases with the same arguments as /scout", () => {
    expect(parseTelegramCommand("/discover")?.name).toBe("discover");
    expect(parseTelegramCommand("/discovery activity:surf")?.name).toBe("discovery");
    expect(parseTelegramCommand("/findme activity:hiking")?.name).toBe("findme");
    const parsed = parseTelegramCommand("/discover activity:surf,relax origin:MAD");
    expect(parsed?.activity_types).toEqual(["surf", "relax"]);
    expect(parsed?.origin).toBe("MAD");
  });

  it("accepts /watch and its aliases", () => {
    for (const name of ["watch", "track", "remind"]) expect(parseTelegramCommand(`/${name} destination:Thailand`)?.name).toBe(name);
    const parsed = parseTelegramCommand("/watch destination:Thailand budget:<1500 activity:cultural-travel");
    expect(parsed?.destination_focus).toEqual(["Thailand"]);
    expect(parsed?.budget_range_eur).toEqual({ min: null, max: 1500 });
    expect(parsed?.activity_types).toEqual(["cultural-travel"]);
  });

  it("reads quoted values with spaces", () => {
    expect(parseTelegramCommand('/scout destination:"Sri Lanka"')?.destination_focus).toEqual(["Sri Lanka"]);
  });
});

describe("modeForCommand", () => {
  it("is discover for /discover, /discovery and /findme, scan for everything else", () => {
    for (const text of ["/discover", "/discovery", "/findme"]) expect(modeForCommand(parseTelegramCommand(text))).toBe("discover");
    for (const text of ["/scout", "/trip", "/plan", "/search", "/watch destination:Bali"]) expect(modeForCommand(parseTelegramCommand(text))).toBe("scan");
    expect(modeForCommand(null)).toBe("scan");
  });
});

describe("buildExecutionContext", () => {
  const message = {
    chat: { id: 999 },
    message_id: 123,
    from: { id: 55, username: "atlas_user", language_code: "en" },
    location: { latitude: 38.7, longitude: -9.1 },
    photo: [
      { file_id: "small", width: 90, height: 90 },
      { file_id: "large", width: 800, height: 800 },
    ],
  };

  it("carries the chat, user, location, largest photo, command and user_context", () => {
    const text = "/scout destination:Portugal activity:surf days:7-10 budget:800-1500 origin:MAD quiet";
    const ctx = buildExecutionContext(message, parseTelegramCommand(text), text);
    expect(ctx.trigger_source).toBe("telegram");
    expect(ctx.request_text).toBe(text);
    expect(ctx.resolved_origin).toBe("MAD");
    expect(ctx.command).toEqual({ name: "scout", raw_args: text.slice("/scout ".length) });
    expect(ctx.telegram).toEqual({
      chat_id: "999",
      message_id: 123,
      user_id: 55,
      username: "atlas_user",
      language_code: "en",
      photo_file_id: "large",
      location: { latitude: 38.7, longitude: -9.1 },
    });
    expect(ctx.user_context).toMatchObject({
      preferred_origins: ["MAD"],
      max_budget_eur: 1500,
      destination_focus: ["Portugal"],
      activity_types: ["surf"],
      stay_duration_days: { min: 7, max: 10 },
      budget_range_eur: { min: 800, max: 1500 },
      notes: ["quiet"],
    });
  });

  it("has a null command and empty user_context fields for free text", () => {
    const ctx = buildExecutionContext({ chat: { id: "999" } }, null, "surf and isolation");
    expect(ctx.command).toBeNull();
    expect(ctx.resolved_origin).toBeNull();
    expect(ctx.user_context.max_budget_eur).toBeNull();
    expect(ctx.user_context.activity_types).toEqual([]);
    expect(ctx.telegram?.location).toBeNull();
    expect(ctx.telegram?.photo_file_id).toBeNull();
  });
});

describe("buildRoutineRequest", () => {
  const block = (text: string) => JSON.parse(text.slice(text.indexOf("execution_context:\n") + "execution_context:\n".length));

  it("puts the message first and the execution_context JSON after it", () => {
    const text = "/discover activity:surf";
    const req = buildRoutineRequest({ chat: { id: 999 }, message_id: 7 }, parseTelegramCommand(text), text);
    expect(req.mode).toBe("discover");
    expect(req.text.startsWith(`${text}\n\nexecution_context:\n`)).toBe(true);
    expect(block(req.text).command.name).toBe("discover");
    expect(block(req.text).telegram.chat_id).toBe("999");
  });

  it("uses scan for plain messages and says so when there is no text", () => {
    const req = buildRoutineRequest({ chat: { id: 1 }, photo: [{ file_id: "p" }] }, null, "");
    expect(req.mode).toBe("scan");
    expect(req.text.startsWith("(no text)")).toBe(true);
    expect(block(req.text).telegram.photo_file_id).toBe("p");
  });

  it("stays within 2,000 characters and keeps the JSON valid for the longest message", () => {
    const words = Array.from({ length: 200 }, (_, i) => `note${i}`).join(" ");
    const text = clipMessage(`/scout destination:Portugal origin:MAD ${words}`);
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    const req = buildRoutineRequest({ chat: { id: 999 }, from: { id: 55, username: "u".repeat(32), language_code: "en" } }, parseTelegramCommand(text), text);
    expect(req.text.length).toBeLessThanOrEqual(2000);
    expect(block(req.text).command.name).toBe("scout");
  });
});

describe("clipMessage", () => {
  it("leaves short text alone and cuts long text with an ellipsis", () => {
    expect(clipMessage("short")).toBe("short");
    const long = clipMessage("x".repeat(2000));
    expect(long).toHaveLength(MAX_MESSAGE_CHARS);
    expect(long.endsWith("...")).toBe(true);
  });
});
