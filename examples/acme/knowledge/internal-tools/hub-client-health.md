---
id: internal-tools/hub-client-health
title: Client health in Acme Hub
section: internal-tools
source:
  connector: notion
  page_id: 11291e35-a2dc-56fc-9b3c-ddbf436d9ba8
  url: https://www.notion.so/acme/Client-health-in-Acme-Hub-11291e35a2dc56fc9b3cddbf436d9ba8
updated_at: 2026-10-01T16:45:00.000Z
lang: en
---

# Client health in Acme Hub

The **Client health** module gives each client company a score, so that customer success can act before a client leaves.

## How the score is computed

The score is recomputed every night from four signals:

| Signal | Source |
|---|---|
| Seat usage: active client users compared with agent seats | Acme Desk |
| SLA compliance of the groups of the client | Acme Desk |
| Open escalations with Acme support | Support team |
| Overdue invoices | Acme Billing |

The result is **Green**, **Amber** or **Red**.

## What to do with a red client

The customer success manager in charge contacts the client within 5 business days, then writes a short recovery note on the client page: the cause, the action agreed and the date of the next check. A client that stays red for a month is discussed in the weekly meeting of the leadership team.

## Who sees it

Every Acme Hub account, Member or Admin, sees client health. Clients never see their score.
