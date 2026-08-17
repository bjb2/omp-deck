---
name: security-quality
description: "Review and harden authentication, authorization, data, APIs, payments, AI agents, and deployments with evidence-based verification."
---

# Security and Quality

## Review order
1. Assets, actors, trust boundaries, and abuse cases.
2. Authentication, authorization, tenant isolation, and secret handling.
3. Input validation, injection, SSRF/XSS/CSRF, file handling, and outbound requests.
4. Data minimization, encryption, audit trails, retention, and recovery.
5. Concurrency, idempotency, replay protection, rate limits, and failure modes.
6. Dependency/config exposure and production defaults.

## Output
Report only grounded findings: severity, exploit/failure path, evidence location, and minimal fix. Distinguish confirmed facts from inference.

## Verification
Exercise the affected boundary or failure scenario; do not claim security from static inspection alone when runtime proof is possible.

## Freshness
Use current OWASP/vendor guidance for volatile recommendations.

## Archived references
Framework-, compliance-, payment-, blockchain-, and red-team-specific checklists remain archived for exact-match use.
