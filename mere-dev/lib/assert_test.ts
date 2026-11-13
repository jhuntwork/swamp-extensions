import { deepStrictEqual, rejects } from "node:assert/strict";
export const assertEquals: typeof deepStrictEqual = deepStrictEqual;
export async function assertRejects(
  operation: () => Promise<unknown>,
  errorType: new (...args: never[]) => Error,
  message: string,
) {
  await rejects(
    operation,
    (error: unknown) =>
      error instanceof errorType && error.message.includes(message),
  );
}
