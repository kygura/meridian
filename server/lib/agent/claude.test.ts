import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODELS, resolveModel, runClaudeChat, setAnthropicClient, toClaudeMessages, toClaudeTools, type AgentTool } from "./claude";

afterEach(() => setAnthropicClient(null));

describe("models", () => {
  it("defaults to Opus 5.5 and rejects unknown ids", () => {
    expect(CLAUDE_MODELS.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(resolveModel("claude-haiku-5-5")).toBe("claude-haiku-5-5");
    expect(resolveModel("gpt-4o-mini")).toBe("claude-opus-5-5");
    expect(resolveModel(undefined)).toBe("claude-opus-5-5");
  });
});

describe("conversion", () => {
  it("turns zod parameters into object input schemas with eager streaming", () => {
    const [t] = toClaudeTools({ find: { description: "d", parameters: z.object({ q: z.string(), n: z.number().optional() }), execute: async () => 1 } });
    expect(t.name).toBe("find");
    expect(t.input_schema).toMatchObject({ type: "object", properties: { q: { type: "string" } }, required: ["q"] });
    expect((t.input_schema as Record<string, unknown>).$schema).toBeUndefined();
    expect(t.eager_input_streaming).toBe(true);
  });

  it("keeps user/assistant text turns, starting with the user", () => {
    expect(
      toClaudeMessages([
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "Lisbon?" },
        { role: "system", content: "x" },
        { role: "assistant", content: "Sure." },
        { role: "user", content: "  " },
      ])
    ).toEqual([
      { role: "user", content: "Lisbon?" },
      { role: "assistant", content: "Sure." },
    ]);
  });
});

/** A fake client whose stream() replays scripted turns and records requests. */
function fakeClient(turns: Array<{ text?: string; content: unknown[]; stop_reason: string }>) {
  const requests: Record<string, unknown>[] = [];
  let i = 0;
  const stream = (req: Record<string, unknown>) => {
    requests.push(structuredClone(req));
    const turn = turns[i++]!;
    const handlers: Array<(d: string) => void> = [];
    return {
      on: (_e: string, cb: (d: string) => void) => {
        handlers.push(cb);
      },
      finalMessage: async () => {
        if (turn.text) handlers.forEach((h) => h(turn.text!));
        return { content: turn.content, stop_reason: turn.stop_reason };
      },
    };
  };
  return { client: { beta: { messages: { stream } } } as unknown as Anthropic, requests };
}

const format = ((type: string, value: unknown) => `${type}:${JSON.stringify(value)}\n`) as never;

describe("runClaudeChat", () => {
  const tools: Record<string, AgentTool> = {
    search_places: {
      description: "search",
      parameters: z.object({ query: z.string() }),
      execute: (async (a: { query: string }) => [{ cityId: "lisbon-portugal", name: a.query }]) as AgentTool["execute"],
    },
  };

  it("runs tools, passes thinking back unchanged, and streams AI SDK parts", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const { client, requests } = fakeClient([
      { text: "Looking. ", content: [thinking, { type: "text", text: "Looking. " }, { type: "tool_use", id: "tu_1", name: "search_places", input: { query: "Lisbon" } }], stop_reason: "tool_use" },
      { text: "Lisbon fits.", content: [{ type: "text", text: "Lisbon fits." }], stop_reason: "end_turn" },
    ]);
    setAnthropicClient(client);
    const parts: string[] = [];
    await runClaudeChat({ model: "claude-opus-5-5", system: "sys", messages: [{ role: "user", content: "Somewhere sunny" }], tools, write: (p) => parts.push(p), format });

    expect(parts).toEqual([
      'text:"Looking. "\n',
      'tool_call:{"toolCallId":"tu_1","toolName":"search_places","args":{"query":"Lisbon"}}\n',
      'tool_result:{"toolCallId":"tu_1","result":[{"cityId":"lisbon-portugal","name":"Lisbon"}]}\n',
      'text:"Lisbon fits."\n',
    ]);
    expect(requests[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], output_config: { effort: "medium" } });
    const second = requests[1]!.messages as Array<{ role: string; content: unknown }>;
    expect(second[1]).toEqual({ role: "assistant", content: [thinking, { type: "text", text: "Looking. " }, { type: "tool_use", id: "tu_1", name: "search_places", input: { query: "Lisbon" } }] });
    expect(second[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "tu_1", content: '[{"cityId":"lisbon-portugal","name":"Lisbon"}]' }]);
  });

  it("sends no fallbacks for Haiku and rejects invalid tool input without running it", async () => {
    let ran = false;
    const strict: Record<string, AgentTool> = {
      search_places: { description: "s", parameters: z.object({ query: z.string() }), execute: (async () => (ran = true)) as AgentTool["execute"] },
    };
    const { client, requests } = fakeClient([
      { content: [{ type: "tool_use", id: "tu_2", name: "search_places", input: { query: 5 } }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
    ]);
    setAnthropicClient(client);
    await runClaudeChat({ model: "claude-haiku-5-5", system: "s", messages: [{ role: "user", content: "q" }], tools: strict, write: () => {}, format });
    expect(ran).toBe(false);
    expect(requests[0]!.fallbacks).toBeUndefined();
    const result = (requests[1]!.messages as Array<{ content: Array<{ is_error?: boolean }> }>)[2]!.content[0]!;
    expect(result.is_error).toBe(true);
  });

  it("ends with a note on a refusal", async () => {
    const { client } = fakeClient([{ content: [], stop_reason: "refusal" }]);
    setAnthropicClient(client);
    const parts: string[] = [];
    await runClaudeChat({ model: "claude-sonnet-5-5", system: "s", messages: [{ role: "user", content: "q" }], tools, write: (p) => parts.push(p), format });
    expect(parts.join("")).toContain("can't help");
  });
});
