---
id: support-ops/refunds-and-credits
title: Refunds and service credits
section: support-ops
source:
  connector: notion
  page_id: 9bc5d415-d37c-7a36-cf21-4aa9223e45bc
  url: https://www.notion.so/acme/Refunds-and-service-credits-9bc5d415d37c7a36cf214aa9223e45bc
updated_at: 2026-10-09T15:20:00.000Z
lang: en
---

# Refunds and service credits

When a client is entitled to a credit or to money back, and who decides. The credit notes are then issued in Acme Billing ([Credit notes in Acme Billing](../internal-tools/billing-credit-notes.md)).

## Service credits for availability

When the monthly availability is below the [uptime commitment](uptime-commitment.md), a client on Growth or Enterprise gets a credit on the fee of that month:

| Monthly availability | Service credit |
|---|---|
| Below 99.9% | 10% |
| Below 99.0% | 25% |
| Below 95.0% | 50% |

A client admin must ask for it within 30 days after the end of the month. The support lead checks the figure on the status page, then asks the finance team for a credit note with the reason **Service credit**.

## Commercial gestures

A credit for another reason (a long bug, a difficult onboarding) is a commercial gesture. The head of support approves it, up to the fee of one month.

## Refunds

Money is paid back only for a billing error, or when the client has left and no future invoice can absorb the credit. Unused months of a contract are not refunded.

## Approval in Acme Billing

Above 1,000 EUR, any credit note also needs the approval of a finance admin in Acme Billing.
