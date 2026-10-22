---
id: product/api-and-webhooks
title: API and webhooks
section: product
source:
  connector: notion
  page_id: 040cc369-37b4-2dd3-9afb-69f67a324fbf
  url: https://www.notion.so/acme/API-and-webhooks-040cc36937b42dd39afb69f67a324fbf
updated_at: 2026-09-02T11:30:00.000Z
lang: en
---

# API and webhooks

Acme Desk has a REST API and webhooks so that clients can connect their own tools. Both are available on the Growth and Enterprise plans.

## API keys

A client admin creates API keys in **Settings** then **API keys**, with **New key**. A key gives access to the data of its company only. The key is shown once: the client must store it safely. Revoking a key stops it at once.

## Limits

Each key can make up to 100 requests per minute. Above that, the API answers with an error and the client must wait before trying again.

## Webhooks

A webhook sends a message to a URL of the client when something happens. Events available:

- a ticket is created,
- a ticket is updated,
- a ticket is solved.

Client admins set them up in **Settings** then **Webhooks**.

## Documentation

The public developer documentation describes every endpoint. Questions from the developers of a client go to Acme support, who escalate to product specialists if needed ([Support levels and escalation](../support-ops/support-levels-and-escalation.md)).
