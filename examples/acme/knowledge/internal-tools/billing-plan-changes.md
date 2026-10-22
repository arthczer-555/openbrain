---
id: internal-tools/billing-plan-changes
title: Plan and seat changes
section: internal-tools
source:
  connector: notion
  page_id: 7f08248f-d596-8bc7-859f-f677a802803f
  url: https://www.notion.so/acme/Plan-and-seat-changes-7f08248fd5968bc7859ff677a802803f
updated_at: 2026-10-12T09:00:00.000Z
lang: en
---

# Plan and seat changes

How to change the plan or the number of agent seats of a client. Three things change, in this order: the contract, Acme Billing and Acme Console.

## The order that works

1. **Agreement**: the account executive gets the agreement of the client in writing. For an annual contract, this is a signed order form amendment ([Proposals and order forms](../sales/proposals-and-order-forms.md)). For a monthly contract, an email from a client admin is enough.
2. **Billing**: the finance team opens the billing account, then **Subscription**, and uses **Change plan** or **Change seats**.
3. **Console**: the customer success manager updates **Plan**, **Agent seats** and, if needed, **Allowed channels** on the company page ([Companies: create and manage](../admin/companies.md)).

Never change the plan in Acme Console before step two: the client would use features it does not pay for.

## When the change takes effect

| Change | Takes effect | Billing |
|---|---|---|
| Upgrade (for example Growth to Enterprise) | At once | Prorated on the next invoice |
| More seats | At once | Prorated on the next invoice |
| Downgrade | At the next renewal date | Lower invoices from that date |
| Fewer seats | At the next renewal date | Lower invoices from that date |

## Downgrade and channels

A downgrade can remove channels. Before the date, the customer success manager checks with the client which groups use them, for example phone on a move from Enterprise to Growth.
