---
id: admin/sso-setup
title: Single sign-on (SSO) for a client company
section: admin
source:
  connector: notion
  page_id: bba9a311-f183-fbac-90e6-a5610b1224a3
  url: https://www.notion.so/acme/Single-sign-on-SSO-for-a-client-company-bba9a311f183fbac90e6a5610b1224a3
updated_at: 2026-09-29T13:40:00.000Z
lang: en
---

# Single sign-on (SSO) for a client company

Single sign-on lets the client users of a company log in to Acme Desk with the identity provider of their company. It is available on the Enterprise plan only and uses SAML.

## Who does what

The customer success manager sets up SSO with the IT team of the client, usually during onboarding. Acme support handles login problems once SSO is live.

## Set it up in Acme Console

1. Ask the IT team of the client for the metadata URL of their identity provider and the email domains of their users.
2. Open the company, then the **Security** tab.
3. Fill in **Identity provider metadata URL** and **Email domains**, then click **Save**.
4. Send the **Acme Desk service URL** shown on the tab to the IT team of the client, so they can register Acme Desk on their side.
5. Ask one client user to log in with **Log in with SSO** and check that it works.
6. Only then switch on **Enforce SSO**.

## Enforce SSO

When **Enforce SSO** is on, users whose email matches one of the domains can no longer log in with a password. Users with another domain (for example an outside contractor) keep their password. Turning **Enforce SSO** off brings back password login at once.

## If a user cannot log in

Check that the email of the client user matches one of the **Email domains** exactly. If it does, the IT team of the client must check that the user is assigned to Acme Desk in their identity provider.
