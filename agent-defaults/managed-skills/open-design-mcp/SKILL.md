---
name: open-design-mcp
description: "Use when reading, editing, or generating designs through the Open Design MCP (xd://mcp__open_design_* tools) — a local-first design workspace app for HTML/JSX/CSS projects. Covers active-context file access, get_artifact vs get_file, and the start_run/get_run/get_artifact commissioned-generation loop. Trigger on \"Open Design\", \"the design I have open\", \"commission a design run\", or any xd://mcp__open_design_ call."
---

Local-first design workspace app (`Open Design.exe` on this machine, already configured as the `open-design` MCP server in `~/.omp/agent/mcp.json` — nothing to install, tools mount as `xd://mcp__open_design_*`). Use for reading/editing a design project's HTML/JSX/CSS files, or commissioning Open Design's own agent to generate/refine a design from a prompt.

## Two distinct modes — pick correctly
1. **Read/edit files directly** (fast, no agent spin-up): `get_artifact`, `get_file`, `search_files`, `list_files`, `write_file`, `create_artifact`, `delete_file`.
2. **Commission a generation run** (Open Design spawns its OWN agent — 5-30 min, not instant): `start_run` → poll `get_run` → `get_artifact`.

Do not conflate them: `write_file`-ing your own design output does NOT get you Open Design's design-quality pipeline; only `start_run` does. Don't cancel a slow `running` status and substitute manual `write_file` as a shortcut — that throws away exactly what this MCP is for.

## Active context — the shortcut that usually works
`get_active_context()` returns the project/file the user currently has open in the Open Design app. Every read tool (`get_file`, `get_artifact`, `search_files`, `list_files`) and `get_artifact`'s `entry` param default to it when `project`/`entry` are omitted — so "this file" / "the design I have open" / "find X in my current design" needs zero lookup, just call the tool directly. Active-file fallback expires ~5 minutes after Open Design goes idle.
Response carries `usedActiveContext` — check it to confirm which project/file was actually hit; pass `project` explicitly to override.

## Reading a design
Prefer `get_artifact` over multiple `get_file` calls — it bundles the entry file plus every referenced sibling (HTML `<script>`/`<link>`/`<img>`/srcset, JSX import/require, CSS `url()`/`@import`) up to depth 3, skipping CDN/data URLs. `include: "all"` returns every project file, `"shallow"` returns just the entry. Soft cap 1.5MB / 200 files (`maxBytes` to override); excess sets `truncated: true`.
`search_files(query)` for a class/component/copy string without pulling every file. `list_files` for metadata only (path/mime/kind/size/mtime); pass `since` (unix ms) to cheap-poll for changes.

## Writing
- `create_artifact(name, content)` — new entry file; rejects existing targets; optional `artifactManifest` sidecar (HTML/Markdown/SVG entries get a default manifest).
- `write_file(path, content)` — overwrite or freshly create any project file, no manifest required; use this to iterate on a file `create_artifact` already made.
- `delete_file(path)` — nested paths OK.
- `delete_project(project, confirm: true)` — irreversible, requires explicit id/name + `confirm: true`, no active-project fallback. Confirm with the user first.

## Commissioning a generation run
```
start_run({ project?, prompt?, skill?, plugin?, inputs?, agent?, model? })
  -> { runId }
get_run(runId) -> poll until status is succeeded | failed | canceled
  -> on success: previewUrl (open in browser) + agentMessage (inner agent's text,
     show this when there's no previewUrl — e.g. the agent asked a clarifying
     question instead of producing files)
```
- `list_skills` / `list_plugins` first to see what Open Design can be asked to make — you don't run the skill/plugin yourself, Open Design's own spawned agent does.
- `list_agents` before passing `start_run.agent` — only agents this call actually returns will spawn on this machine; don't guess `"claude"`/`"codex"`/`"opencode"`.
- `create_project(name)` first if generating into a fresh project — `start_run` requires an existing project.
- **Patience is load-bearing**: runs typically take 5-30 minutes. `status: "running"` with unchanged file mtimes is the inner agent thinking, not a hang. Poll every 30-60s, tell the user "still working" between polls. Only `cancel_run(runId)` if the user explicitly asks to abort — cancelling and hand-writing a "faster" substitute with `write_file` throws away the design-quality pipeline this tool exists for.

## Ambiguous deliverable format
"PPT" / "deck" / "slides" / "presentation" / "document" / "PDF" / "doc" are ambiguous: Open Design natively produces browser-viewable HTML/SVG (including HTML-rendered decks), not a binary `.pptx`/`.docx`/`.pdf` file — exporting that is on you, from its HTML output. Ask which one they want before starting work; don't silently pick one or run both paths.

## Tool reference
`get_active_context` · `get_project` · `get_file(path)` · `get_artifact` · `search_files(query)` · `list_files` · `create_artifact(name, content)` · `write_file(path, content)` · `delete_file(path)` · `delete_project(project, confirm)` · `list_projects` · `create_project(name)` · `list_skills` · `list_plugins` · `list_agents` · `start_run` · `get_run(runId)` · `cancel_run(runId)`
