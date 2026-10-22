---
id: admin/users
title: "Client users: create, invite and import"
section: admin
source:
  connector: notion
  page_id: 0ebc1b5d-75e2-6e73-8cd5-88a096d5fa5f
  url: https://www.notion.so/acme/Client-users-create-invite-and-import-0ebc1b5d75e26e738cd588a096d5fa5f
updated_at: 2026-10-13T10:05:00.000Z
lang: en
---

# Client users: create, invite and import

Client users are the agents and supervisors of a client company who work in Acme Desk.

## Invite one user

Open the company, then **Users** and **Invite user**. Enter the email and pick the role (agent or supervisor). The user receives an invitation email. An invitation expires after 7 days: use **Resend invitation** from the user list.

## Import users from a CSV file

Use **Import CSV** with the columns email, first name, last name, role and group. Rows with an unknown group are rejected and listed after the import.

## Seats

Each active client user uses one agent seat of the company. When every seat is used, **Invite user** and **Import CSV** are disabled until seats are added or a user is deactivated.

## Deactivate a user

Open the user and click **Deactivate**. The seat is freed at once and the tickets of the user stay in their groups.
