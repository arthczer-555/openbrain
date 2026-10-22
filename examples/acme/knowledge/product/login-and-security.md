---
id: product/login-and-security
title: Logging in to Acme Desk
section: product
source:
  connector: notion
  page_id: 29699e19-fb56-b3ce-b979-b288a4433746
  url: https://www.notion.so/acme/Logging-in-to-Acme-Desk-29699e19fb56b3ceb979b288a4433746
updated_at: 2026-09-29T14:05:00.000Z
lang: en
---

# Logging in to Acme Desk

How client users log in to Acme Desk, and how a client admin can make logins safer.

## Password login

By default, users log in with their email and a password of at least 12 characters. **Forgot password** on the login page sends a reset link, valid for one hour.

## Two-factor authentication

Every user can turn on two-factor authentication with an authenticator app in their profile. A client admin can make it mandatory for the whole company in **Settings** then **Security**, with **Require two-factor authentication**. Users who have not set it up are asked to do so at their next login.

## Single sign-on

On the Enterprise plan, users can log in through the identity provider of their company. Acme sets it up with the IT team of the client ([Single sign-on](../admin/sso-setup.md)).

## Sessions

A session lasts 12 hours. A client admin can sign out every user of the company at once from **Settings** then **Security**.

## Blocked login

After 10 failed attempts, login is blocked for 15 minutes for that email. If the problem persists, a client admin can send a new invitation, or the user contacts Acme support.
