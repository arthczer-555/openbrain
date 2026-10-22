---
id: product/ticket-statuses
title: Inbox and ticket statuses
section: product
source:
  connector: notion
  page_id: 832e1055-cdc4-ca3c-6d62-945d3da276e7
  url: https://www.notion.so/acme/Inbox-and-ticket-statuses-832e1055cdc4ca3c6d62945d3da276e7
updated_at: 2026-09-10T13:00:00.000Z
lang: en
---

# Inbox and ticket statuses

## Inbox views

The **Inbox** of a user shows the tickets of the groups they belong to, in three views:

- **My tickets**: assigned to me.
- **Unassigned**: waiting for someone to take them.
- **All group tickets**: every ticket of my groups.

## Statuses

| Status | Meaning |
|---|---|
| New | Received, nobody has answered yet |
| Open | An agent is working on it |
| Pending | Waiting for an answer from the customer; the SLA clock is paused |
| Solved | The agent considers it done |
| Closed | Final: it can no longer be reopened |

## Automatic closing

A solved ticket is closed automatically after 7 days without a reply from the customer. If the customer replies before that, the ticket goes back to **Open**. A reply to a closed ticket creates a new ticket, linked to the old one.

## Why it matters

The retention period of a ticket starts when it is closed ([Data retention in Acme Desk](data-retention.md)).
