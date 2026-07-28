# Frontend gaps and next steps

## Purpose

This document records the current frontend scope, the agreed product direction, and the
features that cannot be completed safely until matching backend capabilities exist.

## Current frontend scope

The frontend in `frontend/` currently supports:

- Phone/password login and Bearer-token sessions.
- Registration using a referral code.
- Manual password recovery through the Admin's personal Zalo.
- Mandatory password change after an Admin reset.
- Responsive CTV and Super Admin navigation.
- CTV overview with F/G balances and redemption-unlock status.
- CTV referral code/link, order creation, order status, and point history.
- Super Admin overview, user creation/search, password reset, order decisions, ledger,
  balance lookup, and redemption.
- Desktop, tablet, Android, and iPhone layouts through responsive web design.

The frontend intentionally follows the backend's current business rules. It does not invent
local-only state for operations that the API cannot persist.

## Agreed UX direction

### CTV

- The CTV home page should prioritize the member profile, F/G balances, pending work, and
  redemption eligibility.
- The profile can currently show the name, phone, referral code, role, and account creation
  date returned by the API.
- Date of birth, address, and a real avatar are not yet available from the backend. Until
  those fields exist, the UI should use initials for the avatar and show unavailable fields as
  not yet updated.
- Phone numbers are read-only in this phase.

### Super Admin

- The Admin experience follows the existing UAT layout: overview, users, orders, ledger, and
  redemption.
- The Admin can see all system data; a CTV remains limited to their own orders, balances, and
  ledger.

### Mobile web

- This phase is responsive web only, not a native mobile application and not a PWA.
- Side navigation becomes a drawer on small screens.
- Wide tables become stacked record cards.
- Primary actions remain large enough for touch use.
- Zalo actions prioritize opening the installed app on mobile devices.

## Order verification gap

The current order API accepts only:

```json
{ "note": "optional text" }
```

The desired order form needs:

- Customer full name.
- Customer phone number.
- A system-generated public order code.
- Payment/transaction reference.
- Optional payment date, amount, and proof image.
- A reason when the Admin requests more information or rejects an order.

These fields must not be implemented as frontend-only placeholders because the Admin would
not be able to retrieve or audit them.

## Desired order flow

1. The CTV enters the customer's registered name and phone number.
2. The system creates a unique, human-readable order code.
3. The CTV enters the payment reference (and proof when supported).
4. The order enters `PENDING`.
5. The Admin may approve, reject, or request additional information.
6. `NEEDS_INFO` unlocks editing for the CTV; the information must match the customer's ID.
7. Approval locks the order and triggers the backend's existing point rules.

## Out of scope for this phase

- Native Android/iOS applications.
- PWA installation and push notifications.
- Activation codes.
- Changing a CTV's login phone number.
- Frontend-only customer or payment records.
- A new reward-request workflow that differs from the current Admin redemption endpoint.

## Acceptance source

Functional acceptance should follow `F:/DuAnMoi/documents/uat-accounts.html`, while visual
direction follows the supplied CTV/Admin screenshots and the existing DuAnMoi Admin frontend.

