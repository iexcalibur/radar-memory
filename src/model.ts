import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

/** The model the engine thinks with: a structured-output call. Swap it to use another model, or to
 *  add logging, budgets or retries around the default. */
export interface Model {
  structured<T>(req: { task: "read" | "sweep"; system: string; prompt: string; schema: z.ZodType<T>; effort: "low" | "medium"; maxTokens: number }): Promise<T | null>;
}

export type Usage = { input_tokens: number; output_tokens: number };

/** Claude through the Anthropic SDK. Haiku is fast and cheap enough to run on every burst. */
export function anthropicModel(opts: { apiKey?: string; model?: string; client?: Anthropic; onUsage?: (task: "read" | "sweep", usage: Usage) => void; onError?: (e: unknown) => void } = {}): Model {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
  const model = opts.model ?? "claude-haiku-5-5";
  return {
    async structured({ task, system, prompt, schema, effort, maxTokens }) {
      try {
        const res = await client.messages.parse({
          model,
          max_tokens: maxTokens,
          thinking: { type: "disabled" },
          system,
          output_config: { effort, format: zodOutputFormat(schema) },
          messages: [{ role: "user", content: prompt }],
        });
        opts.onUsage?.(task, res.usage);
        if (res.stop_reason === "refusal" || !res.parsed_output) return null;
        return schema.parse(res.parsed_output);
      } catch (e) {
        (opts.onError ?? ((x) => console.error("radar-memory:", x instanceof Anthropic.APIError ? `${x.status} ${x.message}` : x)))(e);
        return null;
      }
    },
  };
}
