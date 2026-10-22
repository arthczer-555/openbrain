---
id: support-ops/incident-severity
title: Incident severity levels
section: support-ops
source:
  connector: notion
  page_id: c3e1a239-a80f-f7b2-41e7-9bd9c53a3a2a
  url: https://www.notion.so/acme/Incident-severity-levels-c3e1a239a80ff7b241e79bd9c53a3a2a
updated_at: 2026-09-09T11:00:00.000Z
lang: en
---

# Incident severity levels

Every service incident on Acme Desk gets a severity. It decides who is paged and how often clients are updated.

| Severity | Definition | Acknowledged within | Client updates |
|---|---|---|---|
| P1 Critical | Acme Desk is down, or data is at risk, for many clients | 15 minutes, at any time | Every 30 minutes |
| P2 Major | A key feature (a channel, the inbox, login) is broken for several clients, with no workaround | 1 hour, during support hours | Every 2 hours |
| P3 Minor | A feature is degraded, or broken for one client, with a workaround | Next business day | When fixed |
| P4 Low | Cosmetic problem or question | Best effort | None |

## Choosing the severity

The support agent who sees the problem first sets the severity and can raise it at any time. Only the incident lead can lower it.

## Not covered here

A suspected data breach is a security incident, not a service incident ([Security incidents and data breaches](../legal-security/security-incidents.md)).
