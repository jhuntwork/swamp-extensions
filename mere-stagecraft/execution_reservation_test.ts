import { acquire, release } from "./execution_reservation.ts";

const first = { owner: "run-a", era: "era-a", stage: "author", cycle: 1 };
function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}
function refuses(fn: () => unknown, message: string) {
  try {
    fn();
  } catch (error) {
    assert(error instanceof Error && error.message === message);
    return;
  }
  throw new Error("expected refusal: " + message);
}

Deno.test("acquire is idempotent for the exact same execution", () => {
  const held = acquire(null, first);
  assert(held.epoch === 1 && held.held);
  assert(acquire(held, first) === held);
});
Deno.test("another owner cannot take a held reservation", () => {
  refuses(
    () => acquire(acquire(null, first), { ...first, owner: "run-b" }),
    "reservation-held",
  );
});
Deno.test("the same owner cannot silently replace a held entry", () => {
  const held = acquire(null, first);
  for (const change of [{ era: "era-b" }, { stage: "review" }, { cycle: 2 }]) {
    refuses(() => acquire(held, { ...first, ...change }), "reservation-held");
  }
});
Deno.test("all identity components and the epoch fence release", () => {
  const held = acquire(null, first);
  for (
    const change of [
      { owner: "run-b" },
      { era: "era-b" },
      { stage: "review" },
      { cycle: 2 },
    ]
  ) {
    refuses(
      () => release(held, { ...first, ...change }, held.epoch),
      "reservation-fenced",
    );
  }
  refuses(() => release(held, first, 2), "reservation-fenced");
});
Deno.test("release is repeatable and acquisition increments the epoch", () => {
  const freed = release(acquire(null, first), first, 1);
  assert(!freed.held && freed.epoch === 1);
  assert(!release(freed, first, 1).held);
  const next = acquire(freed, { ...first, owner: "run-b" });
  assert(next.held && next.epoch === 2);
  refuses(() => release(next, first, 1), "reservation-fenced");
});
Deno.test("an absent reservation cannot be released", () => {
  refuses(() => release(null, first, 1), "reservation-fenced");
});
