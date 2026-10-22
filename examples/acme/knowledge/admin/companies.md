---
id: admin/companies
title: "Companies: create and manage"
section: admin
source:
  connector: notion
  page_id: 8b28a849-4a55-8ea3-b69b-e61943e4281c
  url: https://www.notion.so/acme/Companies-create-and-manage-8b28a8494a558ea3b69be61943e4281c
updated_at: 2026-10-14T15:20:00.000Z
lang: en
---

# Companies: create and manage

A company is a client of Acme in Acme Console. Everything else (groups, client users, SLA policies) lives inside a company.

## Create a company

In Acme Console, open **Companies** then **New company**. Fill in the legal name, the plan and the billing contact, then save. The company gets its own workspace in Acme Desk.

## Company settings

| Field | What it controls |
|---|---|
| Plan | Features available to every group of the company (see [Plans and features](../product/plans-and-features.md)) |
| Agent seats | Number of seats bought by the client. Each active client user uses one seat. |
| Allowed channels | The channels (email, live chat, phone) that groups of this company can enable. Only the channels included in the plan can be allowed. A group cannot use a channel that is not allowed here. |
| Holidays | Days that pause SLA clocks for every group |
| Company admins | Client users who can manage groups and users themselves |

The **Security** tab holds single sign-on, available on the Enterprise plan ([Single sign-on](sso-setup.md)).

## Change the plan or the seats

When a client upgrades (for example from Growth to Enterprise), downgrades or changes its number of seats, change **Plan** and **Agent seats** only once the change is recorded in Acme Billing: see [Plan and seat changes](../internal-tools/billing-plan-changes.md).

## Edit or close a company

Closing a company deactivates all its client users. Tickets follow the retention rules of the product. For a client that leaves, follow [Client offboarding](client-offboarding.md).
