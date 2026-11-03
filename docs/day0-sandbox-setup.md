# Day-0 sandbox setup

Everything Rightful needs from the PayPal Developer Dashboard, in the order to do it.
All of it is in the **sandbox**; nothing touches real money.

## 1. Accounts (Testing Tools → Sandbox Accounts)

- [ ] One **US Business** account. This is the program administrator, who pays claims. Give it a
      balance: the sandbox cannot pay out more than the account holds.
- [ ] Several **US Personal** accounts. These are claimants. India and other non-US business accounts
      fail in ways that look like bugs, so keep everything US.
- [ ] Note one Personal account's email for the payouts probe (`PAYPAL_SANDBOX_PAYOUT_EMAIL`).

## 2. App (Apps & Credentials, sandbox toggle on)

- [ ] Create an app of type **Merchant**, linked to the US Business account above.
- [ ] Copy the **Client ID** and **Secret** into `.env` (copy `.env.example` first). Never commit them.

## 3. App features (the app's settings page; save, then allow 10–15 minutes)

- [ ] **Log in with PayPal**: turn it on early, because Return URL changes take up to three hours to apply.
  - Return URL: the deployed API's `https://<api host>/auth/paypal/callback`. PayPal will not save
    `http://localhost` (the dashboard answers "Something went wrong saving the application").
  - Advanced options → information requested: *PayPal account ID (payer ID)* and
    *account verification status*. Nothing else is needed.
  - Privacy policy URL and User agreement URL are required. In the sandbox, `https://example.com` works;
    replace them with real pages before any live use.
- [ ] **Payouts**: on. Claims are paid with `recipient_type: PAYPAL_ID`.
- [ ] **Transaction search**: on (used for reconciliation and by the `payout-id` probe).

## 4. Run the probes

```bash
npm install
npm run probe -- token drand reporting webhooks payouts payout-id
npm run probe -- login
```

`login` prints a link: open it, sign in as a sandbox **Personal** account, and the probe carries on.
Results land in `probes/out/results.json` (gitignored; account IDs and emails are masked).

## What each probe answers

| Probe | Question | If it fails |
|---|---|---|
| `token` | Which scopes does the app have? | Recheck credentials and that the app is a sandbox app |
| `drand` | Can we fetch and verify quicknet beacons, and how fast is a 10,000-payout ledger and audit? | Network or firewall; try another relay |
| `reporting` | Is Transaction Search on? | Enable it in app features, wait 15 min |
| `webhooks` | Any webhooks registered? | Expected empty at first |
| `payouts` | Can the administrator pay a Personal account by email? Venmo too? | Check Payouts is enabled and the business balance |
| `payout-id` | Can a payout go to an account ID, the way claims are paid? | Needs a payment from that account in Transaction Search |
| `login` | Does Log in with PayPal return `verified_account` and `payer_id`? | Wait for activation; check the Return URL |
| `jev` | Optional: one typed screening decision from TypeSafe Jev, and its latency | Set `TYPESAFE_API_KEY` |
