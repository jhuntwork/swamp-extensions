import {
  parseClassification,
  snapshotInvocation,
} from "./pi_snapshot_protocol.ts";

const classification = {
  type: "task",
  scope: "mere_ops",
  confidence: "high",
  reasoning: "A bounded task.",
};
const session = {
  type: "session",
  version: 3,
  id: "test-session",
  cwd: "/test",
};
const settled = { type: "agent_settled", aborted: false };
function message(stopReason = "stop", text = JSON.stringify(classification)) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason,
      content: [{ type: "text", text }],
    },
  };
}
function stream(...events: unknown[]) {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
function refuses(run: () => unknown, expected: string) {
  try {
    run();
  } catch (error) {
    assert(error instanceof Error && error.message === expected);
    return;
  }
  throw new Error("expected refusal: " + expected);
}

Deno.test("snapshot invocation disables tools and discovered task resources; prompt stays on stdin", () => {
  const prompt =
    "@/private/file\n--extension hostile.ts\n$(touch /tmp/unwanted)";
  const invocation = snapshotInvocation("openai-codex/gpt-6-luna", prompt);
  for (
    const flag of [
      "--no-tools",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--no-session",
    ]
  ) {
    assert(invocation.args.includes(flag));
  }
  assert(invocation.stdin === prompt && !invocation.args.includes(prompt));
  assert(invocation.args.at(-1) === "openai-codex/gpt-6-luna");
});
Deno.test("model selection cannot be fuzzy, flags or shell syntax", () => {
  for (
    const model of [
      "luna",
      "--extension",
      "provider/model;bad",
      "provider/model:high",
      "provider/model with spaces",
    ]
  ) {
    refuses(
      () => snapshotInvocation(model, "test"),
      "model must be an explicit provider/model ID",
    );
  }
});
Deno.test("a settled stop returns only the schema-validated final product", () => {
  const result = parseClassification(stream(session, message(), settled), 0);
  assert(JSON.stringify(result) === JSON.stringify(classification));
});
Deno.test("JSON mode zero exit is not sufficient for errors, aborts or truncation", () => {
  for (const reason of ["error", "aborted", "length", "toolUse", "pending"]) {
    refuses(
      () => parseClassification(stream(session, message(reason), settled), 0),
      "pi-response-incomplete",
    );
  }
  refuses(
    () => parseClassification(stream(session, message(), settled), 1),
    "pi-process-failed",
  );
  refuses(
    () => parseClassification(stream(session, message()), 0),
    "pi-not-settled",
  );
  refuses(
    () =>
      parseClassification(
        stream(session, message(), { ...settled, aborted: true }),
        0,
      ),
    "pi-not-settled",
  );
});
Deno.test("agent_end alone is not completion", () => {
  refuses(
    () =>
      parseClassification(
        stream(session, message(), { type: "agent_end", willRetry: false }),
        0,
      ),
    "pi-not-settled",
  );
});
Deno.test("successful automatic retry uses the final authoritative assistant message", () => {
  const output = stream(
    session,
    message("error", ""),
    { type: "auto_retry_start" },
    message(),
    settled,
  );
  assert(parseClassification(output, 0).type === "task");
});
Deno.test("malformed framing and unexpected tool events fail closed", () => {
  refuses(() => parseClassification("not json\n", 0), "invalid-pi-jsonl");
  refuses(
    () => parseClassification(stream(message(), settled), 0),
    "missing-pi-session",
  );
  refuses(
    () =>
      parseClassification(
        stream(
          session,
          { type: "tool_execution_start", toolName: "read" },
          message(),
          settled,
        ),
        0,
      ),
    "unexpected-pi-tool",
  );
  const tool = {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "toolCall", name: "read" }],
    },
  };
  refuses(
    () => parseClassification(stream(session, tool, message(), settled), 0),
    "unexpected-pi-content",
  );
});
Deno.test("invalid classification is rejected rather than repaired by another model call", () => {
  for (
    const text of [
      "```json\n{}\n```",
      "{}",
      JSON.stringify({ ...classification, unexpected: true }),
      JSON.stringify({ ...classification, confidence: "certain" }),
    ]
  ) {
    refuses(
      () =>
        parseClassification(stream(session, message("stop", text), settled), 0),
      "invalid-classification",
    );
  }
});
Deno.test("LF framing preserves Unicode separators inside JSON strings and accepts CRLF", () => {
  const product = { ...classification, reasoning: "one\u2028two\u2029three" };
  const output = stream(
    session,
    message("stop", JSON.stringify(product)),
    settled,
  );
  assert(parseClassification(output, 0).reasoning === product.reasoning);
  assert(
    parseClassification(output.replaceAll("\n", "\r\n"), 0).reasoning ===
      product.reasoning,
  );
});
Deno.test("output bounds are checked before parsing", () => {
  refuses(
    () => parseClassification("x".repeat(4 * 1024 * 1024 + 1), 0),
    "pi-output-limit",
  );
});
