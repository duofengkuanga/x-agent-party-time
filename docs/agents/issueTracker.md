# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `duofengkuanga/x-agent-party-time`. Use the `gh` CLI for tracker operations; an authenticated GitHub connector can perform equivalent supported operations.

GitHub Issues is the canonical home for specs, implementation tickets, and Wayfinder maps and decision tickets. `.scratch/` holds temporary research, prototypes, drafts, and one-off validation assets. Keep domain vocabulary in `CONTEXT.md`, durable decisions in `docs/adr/`, and usage and design guidance in the existing README and product docs.

## Migrated specifications

- [Cooking Bug lifecycle](https://github.com/duofengkuanga/x-agent-party-time/issues/7)
- [Execution input and output minimization](https://github.com/duofengkuanga/x-agent-party-time/issues/15)
- [Repair and Update Skills](https://github.com/duofengkuanga/x-agent-party-time/issues/18)
- [Cooking experience corrections](https://github.com/duofengkuanga/x-agent-party-time/issues/23)
- [External session synchronization](https://github.com/duofengkuanga/x-agent-party-time/issues/32)

These specs link their implementation tickets. Migrated content preserves historical status; review current ADRs and implementation before taking an old ticket. Original EOM-001 and EOM-002 share one joint acceptance issue because their original dependencies formed a cycle.

The migration preserves parent and blocking links in issue bodies. Closed migrated issues remain historical records; do not backfill their native relationships.

## Spec and implementation ticket publishing

One spec is one parent GitHub Issue. Each implementation ticket is its own GitHub Issue and must be a native sub-issue of that spec.

When `/to-spec` publishes a spec, create only the parent Issue. When `/to-tickets` receives that spec, create its tickets in dependency order, then complete this sequence before reporting publication complete:

1. Confirm `gh auth status` reports an active GitHub account with the `repo` scope.
2. Read the ticket database ID: `gh api repos/duofengkuanga/x-agent-party-time/issues/<ticket-number> --jq .id`.
3. Add the ticket as a native sub-issue: `gh api --method POST repos/duofengkuanga/x-agent-party-time/issues/<spec-number>/sub_issues -F sub_issue_id=<ticket-database-id>`.
4. For every blocker, read the blocker's database ID and add the native edge: `gh api --method POST repos/duofengkuanga/x-agent-party-time/issues/<ticket-number>/dependencies/blocked_by -F issue_id=<blocker-database-id>`.
5. Verify the parent lists every new ticket with `gh api repos/duofengkuanga/x-agent-party-time/issues/<spec-number>/sub_issues` and verify each ticket's `issue_dependencies_summary` with `gh api repos/duofengkuanga/x-agent-party-time/issues/<ticket-number>`.

Native sub-issue and dependency relationships are part of publication. If either write or verification fails, report the created Issue numbers and the failed relationship; do not substitute body-only `Parent` or `Blocked by` links for new work.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <path>`. Write multi-line bodies to a temporary file and pass it with `--body-file`.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body-file <path>`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body-file <answer-path>`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
