import type { CommitRules } from "./commit_policy.ts";

/**
 * The commit and branch standards for each repository, as plain data. Change a
 * rule here, bump the extension version, and every delivery that names the
 * profile follows the new rule. Each value was set from the repository's own
 * history (see README.md).
 */
export const PROFILE_NAMES = ["mere", "merelinux"] as const;
export type ProfileName = typeof PROFILE_NAMES[number];

export interface Profile extends CommitRules {
  description: string;
}

export const PROFILES: Record<ProfileName, Profile> = {
  mere: {
    description:
      "The Mere package manager. Features and fixes may explain why in a body; version releases are a bare subject.",
    maxSubjectLength: 80,
    subjectPattern: "",
    allowBody: true,
    noBodyPattern: "^Release [0-9]+\\.[0-9]+\\.[0-9]+$",
    forbidTrailers: true,
    forbidStatusClaims: true,
    branchPattern: "^[a-z0-9][a-z0-9-]*$",
  },
  merelinux: {
    description:
      "MereLinux recipes. A bump or upgrade is a bare subject; a new package may add a line or two saying what it is.",
    maxSubjectLength: 69,
    subjectPattern: "",
    allowBody: true,
    noBodyPattern: "^(?:[a-z0-9._+/-]+: )?(?:[Bb]ump|[Uu]pgrade)\\b",
    forbidTrailers: true,
    forbidStatusClaims: true,
    branchPattern: "^[a-z0-9][a-z0-9._-]*$",
  },
};
