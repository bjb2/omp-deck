---
name: adversarial-ux-test
description: "Use when stress-testing a UI before release — finding what breaks under unusual input, accessibility edge cases, error states, network failures, or user mistakes. Goal: find the failure mode the design didn't consider, while it's still cheap to fix."
---

# Adversarial UX Test

Use when the UI needs to be broken on purpose before users do it for you. Pre-release QA, accessibility audits, form hardening, network-failure paths, state-machine edge cases.

## Triggers

- "Find what breaks this UI"
- "Edge cases for this form"
- "What if the API is slow / down?"
- "Accessibility audit on this screen"
- "Pre-release QA pass"

## Attack categories

1. **Input.** Empty strings, 10k-char paste, unicode (RTL, emoji, ZWJ sequences), copy-paste with leading/trailing whitespace, only-whitespace strings, script-injection payloads in text fields, SQL/NoSQL metacharacters where applicable.
2. **State.** Submit twice (double-click protection?), same form in two tabs, modify-then-navigate (unsaved changes?), refresh mid-flow, deep-link to step 3 of a 5-step flow.
3. **Network.** 500ms latency on every call, full request failure with retry, partial response, slow assets with CLS, offline → online transition.
4. **Permission.** Logged-out access to logged-in URLs, role downgrade mid-session, expired token with in-flight requests, IDOR on object IDs in URLs.
5. **Viewport.** 320px wide, 4K with 200% browser zoom, OS font scale 200%, high-contrast / forced-colors mode, dark mode, RTL layout, screen reader (NVDA/VoiceOver), keyboard-only, switch device.
6. **Time.** DST transitions, leap seconds, timezones east of UTC+12, browser clock wrong, tokens expiring across midnight.

## Workflow

1. **List the contracts.** What does this screen promise? Each promise is an attack surface.
2. **For each contract, find the failure mode.** "Form submits valid input" → boundary cases: empty, max-length, mixed scripts, pasted HTML.
3. **Reproduce.** Run the actual UI. Devtools, real device, real screen reader. If you can't repro, lower confidence.
4. **Score severity.** Critical (data loss, security) > High (blocks core task) > Medium (workaround exists) > Low (cosmetic).
5. **File with repro.** URL, action sequence, expected vs actual, screenshot if visual.

## Tools

- Devtools: throttling, device emulation, accessibility inspector, Lighthouse.
- Screen readers: VoiceOver (mac), NVDA (Windows).
- axe-core / Lighthouse for the a11y baseline.
- `grep` for client-side validation — absence is a finding.

## Pairing

- Form design → run input attacks first; most bugs live there.
- New feature → run state + permission attacks; new code rarely considers existing flows.
- A11y audit → run viewport attacks; keyboard-only + screen reader catches what sighted testing misses.
