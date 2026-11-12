import { z } from "npm:zod@4.6.7";

/** Snapshot-only classification returned by the bounded Pi triage method. */
export const Classification = z.strictObject({
  type: z.enum(["bug", "feature", "package", "task"]),
  scope: z.enum(["mere", "merelinux_recipe", "merelinux_other", "mere_ops"]),
  confidence: z.enum(["low", "medium", "high"]),
  reasoning: z.string().min(1),
});

/** Fixed arguments for a snapshot-only task using the host's stored Pi login.
 * The supplied prompt goes to stdin, never argv or shell syntax. Tool-using
 * stages require a different, OS-enforced execution boundary.
 */
export function snapshotInvocation(model: string, prompt: string) {
  if (!/^[a-z0-9][a-z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(model)) {
    throw new Error("model must be an explicit provider/model ID");
  }
  if (!prompt.trim()) throw new Error("empty prompt");
  return {
    args: [
      "--print",
      "--mode",
      "json",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--model",
      model,
    ],
    stdin: prompt,
  };
}

const Event = z.object({ type: z.string() }).passthrough();
const Message = z.object({
  role: z.literal("assistant"),
  stopReason: z.string(),
  content: z.array(z.object({ type: z.string() }).passthrough()),
});

/** Read authoritative completion, not token deltas or the process exit alone.
 * LF is the only record delimiter: Unicode U+2028/U+2029 belong inside strings.
 * A production process reader must enforce its byte bound while streaming too.
 */
export function parseClassification(stdout: string, exitCode: number) {
  if (exitCode !== 0) throw new Error("pi-process-failed");
  if (new TextEncoder().encode(stdout).length > 4 * 1024 * 1024) {
    throw new Error("pi-output-limit");
  }
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const events = lines.map((line) => {
    try {
      return Event.parse(
        JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line),
      );
    } catch {
      throw new Error("invalid-pi-jsonl");
    }
  });
  if (events[0]?.type !== "session") throw new Error("missing-pi-session");
  const settled = events.at(-1);
  if (settled?.type !== "agent_settled" || settled.aborted !== false) {
    throw new Error("pi-not-settled");
  }
  let last: z.infer<typeof Message> | undefined;
  for (const event of events) {
    if (event.type.startsWith("tool_execution_")) {
      throw new Error("unexpected-pi-tool");
    }
    if (event.type !== "message_end") continue;
    const role = z.object({ role: z.string() }).parse(event.message).role;
    if (role !== "assistant") continue;
    const message = Message.parse(event.message);
    if (
      message.content.some((part) => !["text", "thinking"].includes(part.type))
    ) {
      throw new Error("unexpected-pi-content");
    }
    last = message;
  }
  if (!last || last.stopReason !== "stop") {
    throw new Error("pi-response-incomplete");
  }
  const text = last.content.filter((part) => part.type === "text").map(
    (part) => {
      if (typeof part.text !== "string") throw new Error("invalid-pi-text");
      return part.text;
    },
  ).join("");
  try {
    return Classification.parse(JSON.parse(text));
  } catch {
    throw new Error("invalid-classification");
  }
}
