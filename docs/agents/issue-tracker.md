# Issue tracker: GitHub

Issues live in GitHub Issues for `wannli/obsidian-reader`.
Use the `gh` CLI from this repository.

## Conventions

- Before creating issues, verify the target with
  `gh repo view --json nameWithOwner`.
- Create: `gh issue create --title "..." --body "..."`.
  Use a heredoc for multiline bodies.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,labels,assignees`.
- Comment: `gh issue comment <number> --body "..."`.
- Labels: `gh issue edit <number> --add-label "..."` or
  `--remove-label "..."`.
- Close: post the explanation separately, then `gh issue close <number>`.
  Do not rely on close-with-comment for already-closed issues.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the GitHub issue.

## Relationships and blockers

Use native GitHub sub-issues and issue dependencies where available.

- Link a child through the parent's sub-issues API:
  `gh api --method POST repos/wannli/obsidian-reader/issues/<parent>/sub_issues -F sub_issue_id=<child-database-id>`.
- Add a blocker:
  `gh api --method POST repos/wannli/obsidian-reader/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>`.
- Obtain a database ID:
  `gh api repos/wannli/obsidian-reader/issues/<number> --jq .id`.

Database IDs are not issue numbers or node IDs.

If native relationships are unavailable, put `Part of #<parent>` and
`Blocked by: #<number>` at the top of child bodies, and list children
in the parent's task list. All blockers must be closed before work starts.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding

- A map is one issue labelled `wayfinder:map`, with Notes,
  Decisions-so-far, and Fog sections.
- Child tickets link to the map and use `wayfinder:<type>` labels:
  research, prototype, grilling, or task.
- Before recommending work, refresh the map, live project Status,
  assignees, blockers, and available worktree/session evidence.
  Recommend only open, unclaimed, unblocked work not already underway.
  Conflicting or unavailable status means unverified, not available.
- Among verified available children, use map order.
- Claim with `gh issue edit <number> --add-assignee @me`.
- Resolve by commenting with the result, closing the ticket, and adding
  a summary and link to the map's Decisions-so-far.
- Continue to the next authorised step; respect human-led decisions
  and per-session ticket-resolution limits.
