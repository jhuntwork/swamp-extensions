import { assertEquals } from "./assert_test.ts";
import {
  bumpKind,
  compareVersions,
  inferTagPrefix,
  isPrerelease,
  newestStable,
  seriesOf,
  versionFromTag,
} from "./versions.ts";

Deno.test("compareVersions orders numerically, not lexically", () => {
  assertEquals(compareVersions("1.10.0", "1.9.9") > 0, true);
  assertEquals(compareVersions("2.3.3", "2.3.3"), 0);
  assertEquals(compareVersions("1.0", "1.0.1") < 0, true);
  assertEquals(compareVersions("1.0rc1", "1.0") < 0, true);
  assertEquals(compareVersions("1.0a", "1.0.1") < 0, true);
  assertEquals(compareVersions("20240101", "9") > 0, true);
});

Deno.test("isPrerelease recognises common markers and not names", () => {
  for (
    const v of [
      "1.0-rc1",
      "2.0.0-beta.2",
      "1.2a1",
      "3.0.0.dev1",
      "1.0_pre",
      "24-init",
      "2.43-devel",
    ]
  ) {
    assertEquals(isPrerelease(v), true, v);
  }
  for (const v of ["1.0.0", "2.84.1", "1.3.1.post2", "0.9.8zh", "5.1-8"]) {
    assertEquals(isPrerelease(v), false, v);
  }
});

Deno.test("newestStable skips prereleases", () => {
  assertEquals(
    newestStable(["1.2.0", "1.3.0-rc1", "1.2.5", "1.10.0-beta"]),
    "1.2.5",
  );
  assertEquals(newestStable(["1.0-rc1"]), undefined);
});

Deno.test("versionFromTag applies the prefix and underscore style", () => {
  assertEquals(versionFromTag("v1.2.3", "v", "1.2.0"), "1.2.3");
  assertEquals(versionFromTag("1.2.3", "v", "1.2.0"), undefined);
  assertEquals(versionFromTag("release-1_2_3", "release-", "1.2.0"), "1.2.3");
  assertEquals(versionFromTag("release-1_2_3", "release-", "1_2_0"), "1_2_3");
  assertEquals(versionFromTag("nightly", "", "1.0"), undefined);
});

Deno.test("inferTagPrefix reads the tag shape from the source URL", () => {
  assertEquals(
    inferTagPrefix(
      "https://github.com/o/r/archive/refs/tags/v${recipe.version}.tar.gz",
    ),
    "v",
  );
  assertEquals(
    inferTagPrefix(
      "https://github.com/o/r/archive/refs/tags/${recipe.version}.tar.gz",
    ),
    "",
  );
  assertEquals(
    inferTagPrefix(
      "https://github.com/o/r/releases/download/release-${recipe.version}/x.tgz",
    ),
    "release-",
  );
  assertEquals(inferTagPrefix("https://example.org/fixed.tar.gz"), undefined);
});

Deno.test("seriesOf and bumpKind classify how far a version moved", () => {
  assertEquals(seriesOf("6.18.42"), "6.18");
  assertEquals(seriesOf("62"), "62");
  assertEquals(seriesOf("1.9.17p2"), "1.9");
  assertEquals(bumpKind("5.4.7", "5.5.1"), "minor");
  assertEquals(bumpKind("6.18.42", "7.3"), "major");
  assertEquals(bumpKind("2.3.3", "2.3.4"), "patch");
  assertEquals(bumpKind("62", "63"), "major");
  assertEquals(bumpKind("2.3.3", "2.3.3"), "none");
  assertEquals(bumpKind("2.3.3", "2.3.2"), "none");
});
