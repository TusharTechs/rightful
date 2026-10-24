# Day-0 sandbox setup

Everything Firsthand needs from the PayPal Developer Dashboard, in the order to do it.
All of it is in the **sandbox**; nothing touches real money.

## 1. Accounts (Testing Tools → Sandbox Accounts)

- [ ] One **US Business** account. This is the merchant (the organizer). Payees must be US Business
      accounts in the sandbox, or voids and captures can fail with `PAYEE_ACCOUNT_LOCKED_OR_CLOSED`.
- [ ] Six to ten **US Personal** accounts. These are fans. Give them a balance (e.g. 5000 USD).
      Keep them in the same country as the business account to avoid currency surprises.
- [ ] Note one Personal account's email for payouts (`PAYPAL_SANDBOX_PAYOUT_EMAIL`).

## 2. App (Apps & Credentials, sandbox toggle on)

- [ ] Create an app of type **Merchant**, linked to the US Business account above.
- [ ] Copy the **Client ID** and **Secret** into `.env` (copy `.env.example` first). Never commit them.

## 3. App features (the app's settings page; save, then allow 10–15 minutes)

- [ ] **Log in with PayPal** — turn it on **today**: participants report it can take up to 7 days.
  - Return URL: `http://localhost:5174/callback` (must match `PAYPAL_LIPP_REDIRECT_URI`).
  - Advanced options → information requested: *PayPal account ID (payer ID)* and
    *account verification status*. Nothing else is needed.
- [ ] **Transaction search** — on (needed for reconciliation).
- [ ] **Vault / Save payment methods** — on (needed only for agent delegations). With it off, creating a
      setup token fails with `403 NOT_AUTHORIZED` and the app token has no `vault/payment-tokens` scope.
- [ ] **Payouts** — on, if shown.

## 4. Run the probes

```bash
npm install
npm run probe -- token drand reporting webhooks payouts
npm run probe -- hold
npm run probe -- vault
npm run probe -- login
```

`hold`, `vault` and `login` print a link: open it, sign in as a sandbox **Personal** account,
approve, and the probe carries on. Results land in `probes/out/results.json` (gitignored; account
IDs and emails are masked).

## What each probe answers

| Probe | Question | If it fails |
|---|---|---|
| `token` | Which scopes does the app have? | Recheck credentials and that the app is a sandbox app |
| `drand` | Can we fetch and verify quicknet beacons, and how fast is a 10,000-entry draw? | Network/firewall; try another relay |
| `reporting` | Is Transaction Search on? | Enable it in app features, wait 15 min |
| `webhooks` | Any webhooks registered? | Expected empty on Day 0 |
| `payouts` | Can the organizer pay a fan (resale proceeds)? Venmo too? | Check Payouts is enabled; balance on the business account |
| `hold` | AUTHORIZE → partial capture → void → refund, and does the order carry `account_status` + payer ID? | Use US accounts; read the `issue` and `debug_id` |
| `vault` | Can a fan approve once so an agent can place holds later? | If `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`, agents fall back to per-hold approval |
| `login` | Does Log in with PayPal return `verified_account` and `payer_id`? | Wait for activation; the approved order's `account_status` is the fallback |
| `jev` | Optional: one System-1 screening decision and its latency | Set `TYPESAFE_API_KEY` |
