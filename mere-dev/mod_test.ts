import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { developmentSigningKeyPath, parseBlake3Output } from "./mod.ts";

const digest = "a".repeat(64);

Deno.test("developmentSigningKeyPath uses Mere's standard per-user location", () => {
  assertEquals(
    developmentSigningKeyPath("/home/developer"),
    "/home/developer/.mere/keys/mere.key",
  );
});

Deno.test("parseBlake3Output extracts digest from digest-plus-path output", () => {
  assertEquals(
    parseBlake3Output(`${digest}  /tmp/source.tar.gz\n`),
    digest,
  );
});

Deno.test("parseBlake3Output accepts digest-only output and normalizes case", () => {
  assertEquals(parseBlake3Output(`${"A".repeat(64)}\n`), digest);
});

Deno.test("parseBlake3Output rejects output without a canonical digest", () => {
  assertThrows(
    () => parseBlake3Output("not-a-hash /tmp/source.tar.gz\n"),
    Error,
    "Could not parse a BLAKE3 digest",
  );
});

Deno.test("parseBlake3Output rejects truncated digests", () => {
  assertThrows(
    () => parseBlake3Output(`${"a".repeat(63)}  /tmp/source.tar.gz\n`),
    Error,
    "Could not parse a BLAKE3 digest",
  );
});
