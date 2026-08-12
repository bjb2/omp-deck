---
name: messaging-automation
description: "Build and operate Telegram, WhatsApp, bot, CRM, outreach, and multi-account messaging workflows safely and lawfully."
---

# Messaging Automation

## Scope
Telegram Bot API/MTProto, WhatsApp gateways, CRM inboxes, consent-based outreach, channel adapters, and multi-account operations.

## Workflow
1. Identify account/persona, transport, permissions, and intended recipient.
2. Separate read/search operations from external sends.
3. Require explicit user intent before sending or editing real messages.
4. Enforce consent, opt-out, rate limits, deduplication, idempotency, and auditability.
5. Keep transport adapters separate from CRM/domain orchestration.
6. Verify delivery/status from the real provider surface.

## Boundaries
No spam, credential/account trafficking, covert monitoring, or unsafe growth automation. Use public/opt-in sources and administrator-approved outreach.

## Freshness
Check current Telegram/WhatsApp provider docs for API versions and capability limits.

## Archived runbooks
TeleFocus, GramJS, WAHA, mcp-telegram-cloud, bot-clone, MultiWA, and account-specific procedures are archived and should be loaded only for exact matching systems.
