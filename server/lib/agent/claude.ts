import Anthropic from "@anthropic-ai/sdk";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Claude for the Ask panel and the other agent routes: the selectable models, and a
// streaming tool loop on the official Anthropic SDK. The Ask panel's client (AI SDK v4
// useChat) reads a data stream, so the loop writes text, tool-call and tool-result parts
// in that format; the keyless mock path writes the same parts.

export interface ClaudeModel {
  id: string;
  label: string;
  /** One line for the picker. */
  note: string;
}

/** Selectable in the Ask panel. The first is the default. */
export const CLAUDE_MODELS: ClaudeModel[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Most capable. Slowest and priciest." },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Fast and capable for everyday research." },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Fastest and cheapest." },
];

export const DEFAULT_MODEL = process.env.AGENT_MODEL && CLAUDE_MODELS.some((m) => m.id === process.env.AGENT_MODEL)
  ? process.env.AGENT_MODEL
  : CLAUDE_MODELS[0]!.id;

/** A known model id, or the default for anything else (never trust the client's string). */
export function resolveModel(id: unknown): string {
  return typeof id === "string" && CLAUDE_MODELS.some((m) => m.id === id) ? id : DEFAULT_MODEL;
}

export function hasAnthropicKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Server-side refusal fallback ("default" routes by refusal category) where the model
 * supports it: Opus 5.5 and Sonnet 5.5 on the Claude API. Haiku 5.5 has none.
 */
function fallbackParams(model: string): { betas?: Anthropic.Beta.AnthropicBeta[]; fallbacks?: "default" } {
  return model === "claude-haiku-5-5" ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** Test seam. */
export function setAnthropicClient(c: Anthropic | null): void {
  client = c;
}

export interface AgentTool {
  description: string;
  parameters: ZodTypeAny;
  execute: (args: never) => Promise<unknown>;
}

export function toClaudeTools(tools: Record<string, AgentTool>): Anthropic.Beta.BetaTool[] {
  return Object.entries(tools).map(([name, t]) => {
    const { $schema: _drop, ...schema } = zodToJsonSchema(t.parameters, { $refStrategy: "none" }) as Record<string, unknown>;
    return {
      name,
      description: t.description,
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
      // Inputs stream as generated; the server then skips validation, so every input is
      // parsed with the tool's zod schema below before it runs.
      eager_input_streaming: true,
    };
  });
}

/** Chat history from the client: plain text turns, starting with the user. */
export function toClaudeMessages(messages: Array<{ role: string; content: string }>): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of messages) {
    if ((m.role !== "user" && m.role !== "assistant") || !m.content.trim()) continue;
    if (!out.length && m.role !== "user") continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

const MAX_STEPS = 8;

interface DataStreamWriter {
  write: (part: string) => void;
}
type Format = (typeof import("ai"))["formatDataStreamPart"];

/**
 * The agent loop: stream a turn, run the tools it asks for, send the results back,
 * until the model ends its turn (or MAX_STEPS). Thinking blocks are passed back unchanged
 * inside the turn. A refusal ends the turn with a short note.
 */
export async function runClaudeChat(opts: {
  model: string;
  system: string;
  messages: Array<{ role: string; content: string }>;
  tools: Record<string, AgentTool>;
  write: DataStreamWriter["write"];
  format: Format;
}): Promise<void> {
  const { model, system, tools, write, format } = opts;
  const claudeTools = toClaudeTools(tools);
  const messages = toClaudeMessages(opts.messages);
  let callIndex = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = anthropic().beta.messages.stream({
      model,
      max_tokens: 64000,
      system,
      messages,
      tools: claudeTools,
      output_config: { effort: "medium" },
      ...fallbackParams(model),
    });
    stream.on("text", (delta) => write(format("text", delta)));
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      write(format("text", "\n\nI can't help with that request. Try asking it a different way."));
      return;
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!uses.length) return;
    if (message.stop_reason === "max_tokens") {
      write(format("text", "\n\nThat answer ran too long to finish. Try a narrower question."));
      return;
    }

    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of uses) {
      const toolCallId = use.id || `call-${++callIndex}`;
      write(format("tool_call", { toolCallId, toolName: use.name, args: use.input as never }));
      const tool = tools[use.name];
      const parsed = tool?.parameters.safeParse(use.input);
      let result: unknown;
      let isError = false;
      if (!tool) {
        result = { error: "unknown_tool" };
        isError = true;
      } else if (!parsed!.success) {
        result = { error: "invalid_arguments", issues: parsed!.error.issues.map((i) => i.message) };
        isError = true;
      } else {
        try {
          result = await tool.execute(parsed!.data as never);
        } catch (err) {
          result = { error: "tool_failed", message: err instanceof Error ? err.message : String(err) };
          isError = true;
        }
      }
      write(format("tool_result", { toolCallId, result: result as never }));
      results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result ?? null), ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
}

/** One non-streaming completion returning the text (research briefs, ticker). */
export async function completeText(opts: { model?: string; system: string; prompt: string }): Promise<string> {
  const model = resolveModel(opts.model);
  const response = await anthropic().beta.messages.create({
    model,
    max_tokens: 16000,
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
    output_config: { effort: "low" },
    ...fallbackParams(model),
  });
  if (response.stop_reason === "refusal") throw new Error("refused");
  return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

/** Parse a JSON reply, tolerating a code fence around it. */
export function parseJsonReply<T>(text: string): T {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as T;
}
