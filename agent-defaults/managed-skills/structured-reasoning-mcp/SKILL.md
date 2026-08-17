---
name: structured-reasoning-mcp
description: "Use the sequentialthinking MCP tool only when a thought chain must be explicitly revised, branched, or handed off; otherwise reason natively."
---

# Structured Reasoning (MCP)

## Not a default
Global doctrine forbids requiring sequential-thinking by default. Native reasoning already covers ordinary multi-step work, and every thought is an extra round trip. Never open a chain to look thorough.

## When it earns its cost
- Earlier assumptions must be explicitly retracted as evidence arrives: `isRevision` + `revisesThought`.
- Mutually exclusive designs must be developed separately, then compared: `branchFromThought` + `branchId`.
- A long chain whose intermediate state must survive a handoff to another agent or a later session.

No revision, no branching, no auditable trail needed: skip the tool.

## Use
One tool: `sequentialthinking`. Required every call: `thought`, `thoughtNumber`, `totalThoughts`.
`totalThoughts` is an estimate, not a contract; raise it mid-chain, flagging `needsMoreThoughts` when the problem grew.
`nextThoughtNeeded: false` ends the chain.
Invoke per the harness contract: `write` the JSON args object as `content` to the device path, expected `xd://mcp__sequentialthinking_sequentialthinking`. The server segment is sanitized, so confirm the exact path against this session's own `xd://` inventory before calling, and `read` that path for the full schema.

## Stop conditions
End the chain the moment the decision is made. Never pad thoughts to reach `totalThoughts`. Three thoughts producing no new constraint: abandon the chain and act.
