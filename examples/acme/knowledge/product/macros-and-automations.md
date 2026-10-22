---
id: product/macros-and-automations
title: Macros, tags and automation rules
section: product
source:
  connector: notion
  page_id: 12be4d6e-84e3-d123-81d5-c6d63f5819e0
  url: https://www.notion.so/acme/Macros-tags-and-automation-rules-12be4d6e84e3d12381d5c6d63f5819e0
updated_at: 2026-09-17T10:10:00.000Z
lang: en
---

# Macros, tags and automation rules

## Macros

A macro is a saved reply, with optional actions (add a tag, change the status). Any agent can create personal macros from **Macros**. Shared macros, visible to a whole group, are created by supervisors and client admins.

## Tags

Tags label tickets, for example "refund" or "bug". Agents add them by hand or through a macro. Tags can be used in reports and in automation rules.

## Automation rules

Client admins create automation rules in **Settings** then **Automations**. A rule has:

- **Conditions**: channel, group, tag, priority, words in the subject.
- **Actions**: assign to a group, set the priority, add a tag, notify a supervisor.

Rules run in the order of the list when a ticket is created or updated. A company can have up to 50 active rules.

## Automatic assignment

A supervisor can switch on **Round robin** for a group in Acme Desk: new tickets are then assigned in turn to the agents of the group who are online. Otherwise they wait in **Unassigned**.
