/** Mutations of one valid recipe; mere and our parser must agree on each. */
export function mutations(base: string): Record<string, string> {
  const drop = (re: RegExp) => base.replace(re, "");
  const addToRecipe = (line: string) =>
    base.replace(/^(\s*release .*)$/m, `$1\n    ${line}`);
  return {
    valid: base,
    // required fields
    noName: drop(/^\s*name .*$/m),
    noVersion: drop(/^\s*version .*$/m),
    noRelease: drop(/^\s*release .*$/m),
    // optional fields
    noUrl: drop(/^\s*url .*$/m),
    noDescription: drop(/^\s*description .*$/m),
    noArchs: drop(/^\s*archs .*$/m),
    noLicenses: drop(/^\s*licenses .*$/m),
    // value types and ranges
    badRelease: base.replace(/release 7/, 'release "x"'),
    negRelease: base.replace(/release 7/, "release -1"),
    releaseFloat: base.replace(/release 7/, "release 7.5"),
    releaseZero: base.replace(/release 7/, "release 0"),
    versionNotString: base.replace('version "2.3.3"', "version 2"),
    emptyName: base.replace('name "zlib-ng"', 'name ""'),
    unknownArch: base.replace('"aarch64" "x86_64"', '"mips"'),
    anyArch: base.replace('"aarch64" "x86_64"', '"any"'),
    // hashes are not checked at validate time
    noBlake3: drop(/^\s*blake3 .*$/m),
    badBlake3: base.replace(/blake3 "[a-f0-9]+"/, 'blake3 "zz"'),
    // structure
    emptyFile: "",
    garbage: "recipe {{{",
    noPackage: drop(/package "zlib-ng" \{[\s\S]*?\n\}\n/)
      .replace(/package "zlib-ng-dev" \{[\s\S]*?\n\}\n/, ""),
    noInstall: drop(/install \{[\s\S]*?\n\}\n/),
    noBuild: drop(/build \{[\s\S]*?\n\}\n/),
    twoBuild: base + '\nbuild {\n    script "true"\n}\n',
    twoRecipeNodes: base +
      '\nrecipe {\n    name "b"\n    version "1"\n    release 1\n}\n',
    unknownTopLevel: base + '\nfrobnicate "x"\n',
    unknownRecipeField: addToRecipe('frob "x"'),
    dupName: addToRecipe('name "again"'),
    dupVersion: addToRecipe('version "9"'),
    dupRelease: addToRecipe("release 8"),
    dupDescription: addToRecipe('description "a"'),
    dupUrl: addToRecipe('url "https://x"'),
    dupDepends: addToRecipe('depends "bash"'),
    dupLicenses: addToRecipe('licenses "MIT"'),
    dupArchs: addToRecipe('archs "x86_64"'),
    emptyDepends: base.replace(
      /depends "busybox"[\s\S]*?"musl-dev"/,
      "depends",
    ),
    // sources and packages
    sourceNoUrl: base.replace(/^source "[^"]*"/m, "source"),
    unknownSourceField: base.replace("blake3 ", 'frob "x"\n    blake3 '),
    dupBlake3: base.replace("blake3 ", 'blake3 "00"\n    blake3 '),
    packageNoName: base.replace('package "zlib-ng-dev" {', "package {"),
    unknownPackageField: base.replace(
      'package "zlib-ng-dev" {',
      'package "zlib-ng-dev" {\n    frob "x"',
    ),
    dupPackageFiles: base.replace(
      'package "zlib-ng-dev" {',
      'package "zlib-ng-dev" {\n    files "usr/x"',
    ),
    // KDL syntax
    v2RawString: base.replace('r#"', '#"').replace(/"#(?!")/, '"#'),
  };
}

/** Accept/reject differences we know and have chosen to keep, with the reason. */
export const KNOWN_DIVERGENCES: Record<string, string> = {};
