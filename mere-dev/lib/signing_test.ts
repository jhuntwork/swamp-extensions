import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { decodeSigningKey } from "./build.ts";

Deno.test("decodeSigningKey accepts an 80-byte Mere secret key", () => {
  const bytes = Uint8Array.from([
    0x4d,
    0x45,
    0x52,
    0x45,
    0x4b,
    0x45,
    0x59,
    0x00,
    0x01,
    0x02,
    0x01,
    0x00,
    0x40,
    0x00,
    0x00,
    0x00,
    ...Uint8Array.from({ length: 64 }, (_, index) => index),
  ]);
  const encoded = btoa(String.fromCharCode(...bytes));
  assertEquals(decodeSigningKey(encoded), bytes);
});

Deno.test("decodeSigningKey rejects invalid key lengths", () => {
  const encoded = btoa("not a key");
  assertThrows(
    () => decodeSigningKey(encoded),
    Error,
    "must decode to an 80-byte Mere secret key",
  );
});
