/**
 * Count of deck-managed session rows whose `repo_id` matches
 * `<owner>/<repo>` and whose `worktree` column matches `branch`.
 *
 * Used by the worktree listing endpoint to render the `sessionCount`
 * field on each `WorktreeEntry`. Pulled out of `worktree-service.ts` so
 * callers (and tests) can hit it directly without importing the whole
 * git-spawning service module.
 */
import { getDb } from "./db/index.ts";

export function countSessionsForWorktree(owner: string, repo: string, branch: string): number {
	const row = getDb()
		.query<{ n: number }, [string, string]>(
			"SELECT COUNT(*) AS n FROM session WHERE repo_id = ? AND worktree = ?",
		)
		.get(`${owner}/${repo}`, branch) as { n: number } | null;
	return row?.n ?? 0;
}
