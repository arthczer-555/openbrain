---
id: support-ops/incident-communication
title: Incident communication
section: support-ops
source:
  connector: notion
  page_id: 3d9f9095-97fb-c315-322b-ead3e4f6096f
  url: https://www.notion.so/acme/Incident-communication-3d9f909597fbc315322bead3e4f6096f
updated_at: 2026-10-19T08:20:00.000Z
lang: en
---

# Incident communication

How support keeps clients informed during a service incident (an outage or a broken feature). Security incidents and data breaches follow another process: [Security incidents and data breaches](../legal-security/security-incidents.md).

## Roles

The support lead on duty is the incident lead for communication. The on-call engineer leads the technical side ([Engineering on-call](on-call.md)).

## Status page

For P1 and P2 incidents, the incident lead posts on the public status page:

- a first message within 30 minutes of the start of a P1, within an hour for a P2,
- updates every 30 minutes for a P1 and every 2 hours for a P2 ([Incident severity levels](incident-severity.md)),
- a final message when the service is back.

Use the templates of the status page, and never give a cause before engineering confirms it.

## Emails to clients

For a P1, support also emails the client admins of every affected company, at the start and at the end of the incident.

## After the incident

Engineering writes a post-mortem within 5 business days of a P1. It is sent to Enterprise clients and shared with other clients on request. If the incident lowered the monthly availability, see [Refunds and service credits](refunds-and-credits.md).
