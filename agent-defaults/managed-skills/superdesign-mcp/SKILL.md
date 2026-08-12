---
name: superdesign-mcp
description: "Use the local superdesign MCP to generate a first-pass wireframe/UI/component/logo/icon design SPEC for you to implement as code, iterate on an existing generated design with feedback, extract a design system from a reference screenshot, or browse/compare prior generations via list/gallery/live_gallery — not for rendering actual pixels or images."
---

# Superdesign MCP

## Invoke
Devices are `xd://mcp__superdesign_<tool>`. Write the JSON argument object as `content` with `write`; `read xd://mcp__superdesign_<tool>` returns docs and full schema. Confirm exact paths from this session's `xd://` inventory. Transport is a local stdio MCP server — a bundled `superdesign-mcp-claude-code` node process operating on the current workspace directory. No network calls, no auth.

## Route
Core distinction: `generate`, `iterate`, and `extract_system` do not render pixels. They return structured design SPECIFICATIONS/instructions — layout, hierarchy, tokens, copy — for the calling agent to then implement as real code (HTML/SVG/JSX/etc). Never confuse this with an image generator.
- Need an actual raster image, photo, or rendered mockup pixel asset → `xd://generate_image` (Nano Banana/GPT Image), or the `image`, `imagegen-frontend-web`, `imagegen-frontend-mobile` skills. Not this server.
- Need visual taste/style rules while writing markup whose shape you already know → `design-taste-frontend`, `high-end-visual-design`, `minimalist-ui`, `industrial-brutalist-ui` directly. Superdesign's output feeds those; it does not replace them.
- Need a first-pass wireframe/UI/component/logo/icon spec before writing any code → `generate`.
- Have a generated design plus concrete feedback → `iterate` against its file, not a fresh `generate`.
- Have a reference screenshot and want its design system (palette, type scale, spacing) → `extract_system`, then feed the result into a `generate` prompt.
- Want to see or compare what's already in the workspace → `list` (data) or `gallery` (static HTML) first. Reach for `live_gallery` only when a human needs a browser tab that auto-refreshes while you iterate — for a one-off look at a single rendered file, `browser` open+screenshot is cheaper than starting a server.

## Tool families
Names below are exact (`xd://mcp__superdesign_<name>`); read the device for full schema.
- Generation: `generate` (req prompt, design_type: ui|wireframe|component|logo|icon; optional variations, framework: html|react|vue) — returns a spec, not files or pixels.
- Iteration: `iterate` (req design_file — path to a prior generated design, feedback; optional variations) — returns revision instructions scoped to that file.
- Reference extraction: `extract_system` (req image_path) — returns instructions for deriving a design system from a screenshot/image.
- Browsing: `list` (optional workspace_path) enumerates designs in the workspace; `gallery` (optional workspace_path) builds a static HTML gallery of all of them; `live_gallery` (optional workspace_path, port default 3000) starts a watching gallery server that auto-refreshes on file changes.
- Housekeeping: `check_files` (req manifest: array of {name,size,modified}, optional workspace_path) diffs current files against a manifest for gallery refresh; `cleanup` (optional workspace_path, max_age_days default 30, max_count default 50, dry_run) prunes old designs; `delete` (req filename, optional workspace_path) removes one design file plus its metadata.

## Workflow
1. `generate` a spec for the requested design_type.
2. Implement the spec yourself as real code in the chosen `framework`, written with `write`/`apply_patch` into the workspace — superdesign does not write these files for you.
3. Review with `list` or `gallery`; note the `design_file` path of anything that needs revision.
4. `iterate` with specific feedback against that path; re-implement the returned revision; repeat 3–4 until settled.
5. Periodically `cleanup` (or `delete` a single stale file) so the generated-design store doesn't grow unbounded across many generate/iterate calls. Not part of the design loop — run it standalone, between tasks.
`extract_system` slots in before step 1 only when starting from a reference screenshot instead of a blank prompt.

## Limits
- `workspace_path` defaults to the current directory on every tool that accepts it; pass it explicitly only when targeting a design store outside cwd.
- `generate`/`iterate`/`extract_system` return text instructions only — never binary image data or already-written files. Nothing to hand to `inspect_image`; you own turning the spec into code.
- `design_type` enum is fixed: ui, wireframe, component, logo, icon. No page/flow/animation type — compose multiple `generate` calls for multi-screen work.
- `framework` enum for `generate` is html, react, vue only. No Svelte/Angular — use html and adapt when the target stack isn't one of the three.
- `live_gallery` starts a long-running server (default port 3000) — a service, not a one-shot call. Check for port collisions before starting; nothing here stops it automatically.

## Safety
Everything is local: reads/writes stay under `workspace_path`, `live_gallery` spawns a local node process on a local port, no external network or credentials involved. `delete` has no `dry_run` — it removes `filename` immediately and permanently, no preview, no undo. `cleanup` does accept `dry_run: true` (defaults to actually deleting) — run it with `dry_run: true` first to preview which files age/count thresholds would remove. Confirm the target `filename` (delete) or thresholds (cleanup) with the user before calling either without dry-run.
