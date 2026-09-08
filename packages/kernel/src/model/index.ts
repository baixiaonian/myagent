import type { Usage } from "@myagent/contracts";
import type { ModelMessage } from "../context/index.js";
export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "done"; finishReason: string; usage: Usage | null };
export interface ModelPort {
  stream(
    messages: readonly ModelMessage[],
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent>;
}
