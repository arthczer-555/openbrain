---
id: internal-tools/billing-accounts
title: Billing accounts in Acme Billing
section: internal-tools
source:
  connector: notion
  page_id: 8d051826-51f8-af06-eed8-f7991b0b9ca3
  url: https://www.notion.so/acme/Billing-accounts-in-Acme-Billing-8d05182651f8af06eed8f7991b0b9ca3
updated_at: 2026-10-07T13:05:00.000Z
lang: en
---

# Billing accounts in Acme Billing

In Acme Billing, a billing account is the billing record of one client company. It is not the login of a person: to give a colleague access to the tool, see [Acme Billing overview and access](billing-overview.md).

## Create a billing account

The finance team creates it as soon as the order form is signed. Open **Billing accounts** then **New billing account** and fill in:

| Field | What to enter |
|---|---|
| Legal entity | Legal name of the client, as on the order form |
| VAT number | Required for clients in the European Union |
| Billing contact | Email address that receives the invoices |
| Billing cycle | Monthly or annual |
| Payment method | Card, SEPA direct debit or bank transfer |
| Linked company | The company of the client in Acme Console |

## Statuses

- **Active**: invoices are issued normally.
- **Suspended**: no new invoice is issued. Used for long unpaid balances, decided by the finance admin with the customer success manager.
- **Closed**: after the final invoice of a client that left.

## Change the billing contact

Open the billing account and edit **Billing contact**. The next invoices go to the new address; to send a past invoice again, see [Invoices in Acme Billing](billing-invoices.md).
