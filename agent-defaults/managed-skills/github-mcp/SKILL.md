---
name: github-mcp
description: "Use the GitHub MCP server for structured issue, pull request, review, branch, file, and code-search operations; prefer issue:// / pr:// URIs for reads and the built-in gh wrapper for repo, checkout, push, and Actions chores."
---

# GitHub MCP

## Invoke
Devices are `xd://mcp__github_<tool>`. Write the JSON argument object as `content` with `write`; `read xd://mcp__github_<tool>` returns docs and full schema. Confirm the exact path from this session's `xd://` inventory — the server segment is sanitized and can differ from the config key.

## Route
Three surfaces touch GitHub. Pick one per lookup. Never issue the same lookup through two.
- Read one issue or PR: `issue://<N>`, `pr://<N>`, `pr://<N>/diff`. Disk-cached, cheapest. Default.
- Repo view, PR create/checkout/push, search, Actions watch: built-in `xd://github` (`gh` CLI wrapper).
- MCP: structured writes and review state the other two do not cover, and when a typed result beats parsing CLI text.

## Tool families
Names below are exact; read the device for args beyond the required ones noted.
- Issues: `issue_read`, `issue_write` (req method,owner,repo), `list_issues`, `add_issue_comment`, `sub_issue_write`.
- Pull requests: `pull_request_read`, `list_pull_requests`, `create_pull_request` (req owner,repo,title,head,base), `update_pull_request`, `update_pull_request_branch`, `merge_pull_request`.
- Reviews and review comments: `pull_request_review_write`, `add_comment_to_pending_review`, `add_reply_to_pull_request_comment`, `request_copilot_review`, `assign_copilot_to_issue`.
- Branches and file contents: `create_branch` (req owner,repo,branch), `list_branches`, `get_file_contents`, `create_or_update_file`, `push_files`, `delete_file`.
- Commits, tags, releases: `get_commit`, `list_commits`, `list_tags`, `list_releases`, `get_latest_release`.
- Search, all req query: `search_code`, `search_issues`, `search_pull_requests`, `search_repositories`, `search_users`.
- User and org context: `get_me` (no args; use to fill a missing owner), `get_teams`, `get_team_members`.
- Repo lifecycle: `create_repository`, `fork_repository`.

### Review workflow
Stateful; order matters and a wrong first call fails.
1. `pull_request_review_write` with `method: create` and no `event` — leaves a pending review.
2. `add_comment_to_pending_review` per comment (req owner,repo,pullNumber,path,body,subjectType). Requires an already-existing pending review; never call it first.
3. `pull_request_review_write` with `method: submit` and an `event` to publish.
Read the device schema for the `method` and `event` enums before the first call.

## Limits
- PAT is account `kaka-sangi`, scopes `gist, read:org, repo, workflow`. No org administration, no repository deletion, no settings changes. Those calls fail with a permission error — do not retry, report the missing scope.
- `read:org` is read-only: `get_teams` and `get_team_members` cover only accessible orgs.
- No workflow, run, or notification tools exist in this toolset despite the `workflow` scope. Watch Actions with `xd://github` `op: run_watch`.
- Transport is a local Docker container (`ghcr.io/github/github-mcp-server`). A Docker daemon outage presents as this server being absent, not as a GitHub failure.

## Safety
Writes hit a real remote and are externally visible: `create_pull_request`, `merge_pull_request`, `push_files`, `create_or_update_file`, `delete_file`, `assign_copilot_to_issue`. Confirm intent and name the exact `owner/repo` and number before calling. Prefer `draft: true` when unsure.
