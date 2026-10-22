---
id: support-ops/on-call
title: Engineering on-call
section: support-ops
source:
  connector: notion
  page_id: 389ded1b-2165-d672-184d-768700577bf3
  url: https://www.notion.so/acme/Engineering-on-call-389ded1b2165d672184d768700577bf3
updated_at: 2026-09-09T10:30:00.000Z
lang: en
---

# Engineering on-call

One engineer is on call at any time to handle incidents on Acme Desk.

## The rota

The rota changes every week, on Monday at 10:00, with a short handover between the outgoing and the incoming engineer. Engineers agree on swaps between themselves and record them in the paging tool.

## When the on-call engineer is paged

| Severity | During support hours | Outside support hours |
|---|---|---|
| P1 | Paged | Paged |
| P2 | Paged | Next morning |
| P3, P4 | Not paged: handled as bugs | Not paged |

Severity levels are defined in [Incident severity levels](incident-severity.md). Support hours are in [Acme support hours and response targets](support-hours.md).

## Response

The on-call engineer acknowledges a P1 page within 15 minutes and becomes the technical lead of the incident. Communication with clients stays with support ([Incident communication](incident-communication.md)).

## Who can page

Any member of support, and the monitoring alerts. When in doubt between P1 and P2, page.
