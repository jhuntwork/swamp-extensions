import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  isWithinWorkspace,
  normalizeRepository,
  onlyLoopMounts,
  unsafeDiskCommands,
} from "./mod.ts";

Deno.test("rescue paths must remain below the Swamp workspace", () => {
  assertEquals(
    isWithinWorkspace("/repo/.swamp/mere", "/repo/.swamp/mere/a"),
    true,
  );
  assertEquals(
    isWithinWorkspace("/repo/.swamp/mere", "/repo/.swamp/mere"),
    false,
  );
  assertEquals(
    isWithinWorkspace("/repo/.swamp/mere", "/repo/.swamp/mere/../other"),
    false,
  );
  assertEquals(
    isWithinWorkspace("/repo/.swamp/mere", "/repo/.swamp/mere-other"),
    false,
  );
});

Deno.test("repository identity accepts transport spellings but not another repository", () => {
  assertEquals(
    normalizeRepository("https://github.com/jhuntwork/merelinux.git"),
    "github.com/jhuntwork/merelinux",
  );
  assertEquals(
    normalizeRepository("git@github.com:jhuntwork/merelinux.git"),
    "github.com/jhuntwork/merelinux",
  );
  assertEquals(
    normalizeRepository("ssh://git@github.com/jhuntwork/merelinux"),
    "github.com/jhuntwork/merelinux",
  );
  assertEquals(
    normalizeRepository("https://github.com/other/project.git"),
    "github.com/other/project",
  );
  assertThrows(() => normalizeRepository("not a URL"));
});

Deno.test("disk safety rejects activation and repair commands", () => {
  assertEquals(
    unsafeDiskCommands([
      ["mount", "-o", "loop,offset=1", "image.raw", "/tmp/mnt"],
      ["losetup", "-f"],
    ]),
    [],
  );
  assertEquals(
    unsafeDiskCommands([["swapon", "/dev/sdb"], ["e2fsck", "-p", "/dev/sdb1"]])
      .length,
    2,
  );
});

Deno.test("disk safety only accepts explicit loop mounts", () => {
  assertEquals(
    onlyLoopMounts([["mount", "-o", "loop", "image.raw", "/tmp/mnt"]]),
    true,
  );
  assertEquals(onlyLoopMounts([["mount", "--version"]]), true);
  assertEquals(onlyLoopMounts([["mount", "/dev/sdb1", "/mnt"]]), false);
  assertEquals(onlyLoopMounts([["umount", "/tmp/mnt"]]), true);
});
