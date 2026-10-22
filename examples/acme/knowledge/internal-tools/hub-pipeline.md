---
id: internal-tools/hub-pipeline
title: "Acme Hub pipeline: track deals"
section: internal-tools
source:
  connector: notion
  page_id: ae8c2325-61fb-cafb-7f88-457f5f1da49f
  url: https://www.notion.so/acme/Acme-Hub-pipeline-track-deals-ae8c232561fbcafb7f88457f5f1da49f
updated_at: 2026-09-22T10:30:00.000Z
lang: en
---

# Acme Hub pipeline: track deals

The **Pipeline** module holds every open deal with a prospect or an existing client. Its stages are the ones of the [sales process](../sales/sales-process.md).

## Create a deal

Click **New deal** and fill in:

| Field | What to enter |
|---|---|
| Company | The prospect or client company |
| Stage | Current stage of the sales process |
| Plan | The Acme Desk plan discussed (Starter, Growth or Enterprise) |
| Seats | Number of agent seats discussed |
| Expected close date | Best estimate, updated when it moves |
| Next step | One concrete action with a date |
| Owner | The account executive in charge |

## Keep it up to date

Update **Stage** and **Next step** before the weekly pipeline review on Monday morning. A deal with no next step is shown in orange.

## When a deal is won or lost

Move the deal to **Closed won** once the order form is signed. Acme Hub then creates a handover task for the customer success manager (see [Account roles and handover](../sales/account-roles-and-handover.md)). A lost deal goes to **Closed lost** with a reason.
