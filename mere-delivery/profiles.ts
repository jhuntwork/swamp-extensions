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
  /**
   * The formatting a pull request body may use. Markdown keeps rationale and
   * trade-offs readable; the delivery boundary does not impose a prose shape.
   */
  descriptionStyle: "paragraph" | "markdown";
}

export const PROFILES: Record<ProfileName, Profile> = {
  mere: {
    description:
      "The Mere package manager. Commit bodies may use natural Markdown to explain why a change is needed without repeating what the subject and diff already show.",
    descriptionStyle: "markdown",
    maxSubjectLength: 80,
    subjectPattern: "",
    allowBody: true,
    noBodyPattern: "",
    forbidTrailers: true,
    forbidStatusClaims: true,
    forbidConventionalPrefix: true,
    branchPattern: "^[a-z0-9][a-z0-9-]*$",
  },
  merelinux: {
    description:
      "MereLinux recipes. Bumps and upgrades may carry the upstream rationale in the commit body, which becomes the pull-request body.",
    descriptionStyle: "markdown",
    maxSubjectLength: 69,
    subjectPattern: "",
    allowBody: true,
    noBodyPattern: "",
    forbidTrailers: true,
    forbidStatusClaims: true,
    forbidConventionalPrefix: true,
    branchPattern: "^[a-z0-9][a-z0-9._-]*$",
  },
};
