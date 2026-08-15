# Navigation — competitive-landscape

One folder, six research files, one synthesis. Read in this order.

## Read order

1. **Start:** [00-MASTER-SYNTHESIS.md](00-MASTER-SYNTHESIS.md) — the impact-prioritized recommendation matrix. Tiers 0–9, ~50 distinct recommendations mapped to the 24 known gaps in omp-deck. **Read this first.**
2. **Then:** the research file behind each tier you want to ship:
   - Tier 0, 1, 5.5 → [01-remote-vps-access.md](01-remote-vps-access.md)
   - Tier 1, 4.4 → [02-multi-agent-orchestration.md](02-multi-agent-orchestration.md)
   - Tier 4 → [03-pi-lineage-acp-mcp.md](03-pi-lineage-acp-mcp.md)
   - Tier 2, 5.1, 5.2 → [04-adhd-focus-productivity.md](04-adhd-focus-productivity.md)
   - Tier 3, 5.3 → [06-storefront-ux-patterns.md](06-storefront-ux-patterns.md)
3. **Cross-reference:** [05-omp-deck-current-state.md](05-omp-deck-current-state.md) — the ground-truth map of the existing app surface. Every recommendation cites a slot in this file.

## File summary

| File | Bytes | Sections | Purpose |
|---|---|---|---|
| `00-MASTER-SYNTHESIS.md` | 42 KB | 9 tiers, 50 recommendations | The "what to build" master list |
| `01-remote-vps-access.md` | 33 KB | 15 projects, 8 patterns | Remote/VPS-access category |
| `02-multi-agent-orchestration.md` | 30 KB | 19 projects, 8 patterns | Multi-agent orchestration category |
| `03-pi-lineage-acp-mcp.md` | 21 KB | 16 projects, 9 patterns | Pi lineage + ACP/MCP ecosystem |
| `04-adhd-focus-productivity.md` | 25 KB | 13 projects, 12 patterns | ADHD/focus productivity category |
| `05-omp-deck-current-state.md` | 24 KB | 24 known gaps | Ground-truth map of omp-deck |
| `06-storefront-ux-patterns.md` | 25 KB | 12 references, 12 patterns | Storefront UX category |

**Total:** ~200 KB, ~83 distinct projects/tools referenced, ~57 distinct Pattern-to-apply entries.

## Source paper

The research was triggered by [../ade-research.md](../ade-research.md), which surveyed 72 open-source projects in the "remote-capable AI dev workspace" category. This folder is a native appliqué of that paper — every recommendation ships as an addition to omp-deck's existing surface, not a fork or copy of any competitor.

## Verification

- Each research file has a §"Open Questions" / §"Verify-before-claim" tail. None of the patterns in the master synthesis should move to `In Progress` until the corresponding open questions are checked.
- Slot names in the master synthesis (e.g. `apps/server/src/routes-tasks.ts`) are reality-checked against `05-omp-deck-current-state.md`.
- All six research files were drafted by parallel subagents using `web_search`, `read`, `xd://github`, `xd://deepwiki`, `xd://parallel`, `xd://crawl4ai`, `xd://firecrawl`, `xd://exa`, `xd://tavily`. Where the upstream MCP tool failed (e.g. xd://github auth in some sessions), the substitute was web search + direct GitHub REST API calls.

## How to ship the recommendations

Tier 0 first (foundational; unblocks everything else). Then Tier 1 (parallel agents). Tier 2 (ADHD UX) parallel-ships with Tier 3 (storefront). Tier 4 (ACP/MCP) and Tier 5 (polish) are ongoing. Tier 8 in the synthesis file already groups the work into shippable phases.

## Authors

- This folder was produced by the orchestrator + 6 parallel research subagents on 2026-08-16.
- See `00-MASTER-SYNTHESIS.md` Tier 9 for the full source index.
