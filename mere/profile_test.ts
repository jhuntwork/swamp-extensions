import { assertEquals } from "jsr:@std/assert@1.0.14";
import { profileArgv, renderProfile } from "./profile.ts";

Deno.test("renderProfile quotes package names as KDL strings", () => {
  assertEquals(
    renderProfile(["core/zlib-ng", "name with spaces", 'quote"name']),
    `profile {\n  package "core/zlib-ng"\n  package "name with spaces"\n  package "quote\\\"name"\n}\n`,
  );
});

Deno.test("profileArgv uses Mere shell with a terminator", () => {
  assertEquals(
    profileArgv("/repo/.swamp/mere/root", "/tmp/profile.kdl", [
      "zlib",
      "--version",
    ]),
    [
      "--root",
      "/repo/.swamp/mere/root",
      "shell",
      "/tmp/profile.kdl",
      "--",
      "zlib",
      "--version",
    ],
  );
});
