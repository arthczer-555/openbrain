---
id: admin/sla-policies
title: Set up SLA policies and business hours
section: admin
source:
  connector: notion
  page_id: 1f8e595f-d14c-50ae-832c-f46fb4c2f263
  url: https://www.notion.so/acme/Set-up-SLA-policies-and-business-hours-1f8e595fd14c50ae832cf46fb4c2f263
updated_at: 2026-10-14T16:02:00.000Z
lang: en
---

# Set up SLA policies and business hours

How to configure in Acme Console the targets that the groups of a client must meet. How the clock works is explained in [SLA policies and business hours](../product/sla-and-business-hours.md).

## Create an SLA policy

SLA policies belong to the company. Open the company, then the **SLA policies** tab and **New policy**. For each priority (low, normal, high, urgent), set a **First response target** and a **Resolution target**, in business hours.

## How many policies a company can have

The number of SLA policies depends on the plan of the company. On the Starter plan, a company has one SLA policy, shared by all its groups: **New policy** is disabled once that policy exists. Growth and Enterprise have unlimited SLA policies. To get more, the client must change plan ([Plans and features](../product/plans-and-features.md)).

## Apply a policy and business hours to a group

Open the group, pick the policy in **SLA policy**, then set **Business hours**: time zone, working days and opening hours. By default a group works Monday to Friday, 9:00 to 18:00, in the time zone of the company. Holidays are not set here: they are set once on the company and pause every group.

## Who can change them

The customer success manager sets them up during onboarding. Afterwards, client admins can change SLA policies and business hours themselves in Acme Desk, under **Settings**.
