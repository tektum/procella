// Renovate global (self-hosted) configuration.
//
// This instance ONLY manages packages/types/tygo/go.mod — Pulumi SDK bumps that
// need TypeScript type regeneration via postUpgradeTasks, which the hosted Mend
// app cannot run for security reasons. Everything else (bun/npm, GitHub Actions,
// esc-eval/go.mod) is handled by the hosted Renovate GitHub App via renovate.json.
//
// requireConfig: "ignored" means this run never reads renovate.json — that file
// belongs exclusively to the hosted app. The hosted app in turn carves out
// packages/types/tygo/** with an `enabled: false` packageRule, so the two
// instances never touch the same dependency.

module.exports = {
  platform: "github",
  repositories: ["tektum/procella"],

  onboarding: false,
  // Do NOT read renovate.json — it is the hosted app's config.
  requireConfig: "ignored",

  // Scope: gomod manager, tygo module only. The only direct require there is
  // github.com/pulumi/pulumi/sdk/v3 (the rest are `// indirect`), so this
  // instance only ever produces the typegen PR.
  enabledManagers: ["gomod"],
  includePaths: ["packages/types/tygo/**"],

  // Distinct branch namespace — hosted app owns "renovate/".
  branchPrefix: "renovate-typegen/",

  // Whitelist commands that postUpgradeTasks may run.
  // Each entry is a regex matched against the resolved command string.
  // Keep this list minimal — every entry is arbitrary code execution.
  allowedCommands: [
    "^bun install$",
    "^bun run types:generate$",
  ],

  // Tools (bun, go) are installed by the workflow steps before Renovate runs.
  // "global" tells Renovate to use whatever is already on PATH.
  binarySource: "global",

  packageRules: [
    {
      description: "Regenerate TypeScript types after Pulumi Go SDK bumps",
      matchPackageNames: ["github.com/pulumi/pulumi/sdk/v3"],
      postUpgradeTasks: {
        commands: ["bun install", "bun run types:generate"],
        fileFilters: ["packages/types/**", "bun.lock"],
        executionMode: "branch",
      },
    },
  ],

  // platformCommit signs commits via GitHub's API ("verified" badge).
  // DISABLED: incompatible with postUpgradeTasks — platformCommit bypasses
  // the local git-commit flow where post-upgrade commands execute.
  // platformCommit: true,
};
