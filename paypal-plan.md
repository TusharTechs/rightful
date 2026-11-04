# PayPal SDK integration plan and contract sheet

Written before any code change, following the workflow of APIMatic's Context Plugin for PayPal
(`typescript-integrate-paypal`, lookup layer `typescript-getting-started`). Every SDK fact below
comes from the SDK map (`sdk-map.md`, `map/operations/transaction-search.md`) and the model sources it
names, read at commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2` of
`github.com/context-plugins/paypal-typescript-sdk` (package `paypal` 2.29.0), not from memory.

## Scope

Replace `@paypal/paypal-server-sdk` 2.5.0 in `src/paypal/sdk.ts` with the plugin's SDK (`paypal`),
for the two reporting reads Rightful makes. Nothing else moves: Payouts and Log in with PayPal are not
in this SDK (its five resources are orders, payments, vault, transactionSearch, subscriptions) and stay
on `src/paypal/client.ts`.

| Rightful use | Operation | Wire |
| --- | --- | --- |
| Reconciliation (`src/claims/reconcile.ts`): every paid claim in PayPal's history | `client.transactionSearch.searchTransactions` | `GET /v1/reporting/transactions` |
| Funding check before a live program pays | `client.transactionSearch.searchBalances` | `GET /v1/reporting/balances` |

## Repo survey

- ESM only (`"type": "module"`), Node ≥ 22, TypeScript strict, run by `tsx`; one dialect, so
  `instanceof PaypalError` is reliable.
- Conventions: PayPal edges live in `src/paypal/*.ts` behind small interfaces (exemplar:
  `src/claims/payouts-port.ts`); money is integer cents converted at the edge (`src/paypal/money.ts`).
- Checks: `npm run typecheck` (tsc --noEmit), `npm test` (node:test via tsx). Baseline on the
  untouched tree: typecheck clean, 58 tests pass.
- Credentials: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` from `.env` / Render's env group;
  `PayPalClient.fromEnv` refuses anything but `PAYPAL_ENV=sandbox`.
- Read-only smoke against the real sandbox credential, done with the npm SDK on Nov 4: both
  operations answer 200 (balance 5,011.87 USD; 28 transactions in 30 days). Not plan-gated.

## Contract sheet

**Package and import:** `paypal`, installed from the repository pinned to the commit above. Import
only from the package root: `import { PaypalClient, PaypalError } from "paypal"`. No deep imports.
Do not import the model named `Error` (not needed).

**Client:** `new PaypalClient(options)`; fields used: `oauth2: { clientId, clientSecret }`,
`retry`, `logging`, `fetch` (tests only). Built once in a factory and held; resources are lazy getters.

**Host decision:** the SDK declares one environment and its default base URL is
`https://api-m.sandbox.paypal.com`; no `serverOptions` override. That is the only host Rightful may
talk to, so the factory refuses to build unless `PAYPAL_ENV` is `sandbox` (or unset) and both
credentials are non-empty (an unset credential is not an SDK error; it would 401 later).

### searchTransactions

- Signature: `searchTransactions(request: TransactionSearch.SearchTransactionsRequest, options?: RequestOptions): ApiPromise<SearchResponse, TransactionSearch.SearchTransactionsError>`
- Request fields sent: `startDate` (required, string, ISO `yyyy-MM-ddTHH:mm:ssZ`), `endDate` (required),
  `fields: "transaction_info"` (equals the documented default; sent explicitly because the parser
  below reads only `transactionInfo`), `pageSize: 500`, `page` (1..`totalPages`).
- Returns `SearchResponse`: all members optional — `transactionDetails?: TransactionDetails[]`,
  `lastRefreshedDatetime?: string`, `page?`, `totalItems?`, `totalPages?`.
  `TransactionDetails.transactionInfo?: TransactionInformation` with optional `transactionId`,
  `transactionEventCode`, `transactionAmount?: Money`, `transactionStatus`, `transactionNote`,
  `transactionSubject`. `Money = { currencyCode: string; value: string }` (both required); `value` is
  signed for debits ("-1.00").
- Error arms: `"searchError"` [default] `SearchError`; `"undeclared"` [default body that did not fit].
- Not paginated by the SDK: page explicitly until `page >= totalPages` (cap 50 pages).

### searchBalances

- Signature: `searchBalances(request: TransactionSearch.SearchBalancesRequest, options?: RequestOptions): ApiPromise<BalancesResponse, TransactionSearch.SearchBalancesError>`
- Request fields sent: `currencyCode` (optional, string). `asOfTime` not sent.
- Returns `BalancesResponse`: `balances?: BalanceInformation[]`; `BalanceInformation` has required
  `currency: string`, `totalBalance: Money`, optional `availableBalance?: Money`.
- Error arms: `"defaultError"` [400], `"defaultError2"` [403], `"defaultError3"` [500],
  `"defaultError4"` [default], all `DefaultError`; `"undeclared"`.

### 1b.1 Durable writes

none. Both operations are reads; the money-moving write (Payouts) is outside this SDK and already has
its claim (`programs.payout_batches` planned in the commit transaction) and idempotency key
(`sender_batch_id` from the program ID).

### 1b.2 Cross-operation invariants

| Invariant | Where the legal set comes from | Enforced where | The test that proves it |
| --- | --- | --- | --- |
| A history record counts for a claim only if its `transactionId` is the one Payouts gave that claim's item | `claims.payout_transaction_id`, written by Payouts read-back | `reconcileProgram` matches by that ID only | `test/reconcile.test.ts` (a record under another ID is "missing") |

### 1b.3 Optional request fields

| Field | What requires it | Set it? |
| --- | --- | --- |
| `fields` | the parser reads `transactionInfo` only; pin it rather than rely on the default | ✅ `"transaction_info"` |
| `pageSize` | fewer round trips for large programs (the API allows up to 500) | ✅ 500 |
| `page` | explicit paging (the SDK does not page) | ✅ |
| `balanceAffectingRecordsOnly` | nothing | ❌ leave it out. Found by the request test: the SDK itself sends its default `"Y"` on the wire; that is the SDK's choice, not ours, and suits payouts (balance-affecting) |
| `transactionId`, `transactionType`, `transactionStatus`, `transactionAmount`, `transactionCurrency`, `paymentInstrumentType`, `storeId`, `terminalId` | nothing | ❌ leave them out |
| `currencyCode` (balances) | the program's currency | ✅ |
| `asOfTime` | nothing | ❌ leave it out |

### 1b.4 When the API says no

Neither operation carries a caller's data (only our own dates and currency), so refusals are ours:

| Outcome | Rightful answers | Test |
| --- | --- | --- |
| `searchTransactions` rejects (any `PaypalError`) | reconciliation leaves the program as it was and the clock records `reconcile: <message>` in its error list; retried on the next tick | fake a 500 → the reconcile call rejects and no `reconciliation` is written |
| `searchBalances` rejects (any `PaypalError`) | distribution refuses to start (fails closed): `ClaimError wrong_state` "could not confirm the PayPal balance" → HTTP 409 | fake a 403 → distribute rejects, nothing sent |
| balance below the payout total | distribution refuses to start, 409, with both amounts | `test/reconcile.test.ts` |
| not a `PaypalError` (e.g. a caller abort) | rethrown | — |

### Retries, timeouts, logging

- Retry: SDK defaults retry GET on 408/429/5xx up to 3 times with exponential backoff. Keep them;
  set `retry.timeout: 20_000` per attempt, matching `src/paypal/client.ts`.
- Logging: set `logging: { level: "off" }` explicitly so `PAYPAL_CLIENT_LOG` cannot turn request
  logging on from outside the code (responses carry account IDs and balances).

## Tests (per `typescript-testing`)

Fake `fetch` through `ClientOptions.fetch` (never mock the client); stub bodies in wire shape
(`transaction_details`, `transaction_info`, `transaction_amount.currency_code`); the first request
is the OAuth token request to `/v1/oauth2/token`; `retry: { maxRetries: 0 }` on test clients.

## Assumptions and blockers

- Install is a build from source (`prepare: tshy`). Render's `npm ci` must build it too; if it cannot,
  roll back to `@paypal/paypal-server-sdk` (Blocker for deploy only, not for the code).
- No other blockers.

## Required reading

- MUST load `typescript-error-handling` (the error model above; family narrowed on `err.kind`).
- MUST load `typescript-client-initialization` (factory with the credential check; build once).
- MUST load `typescript-testing` (fake `fetch`, wire-shape stubs, the token request first).
- MUST load `typescript-configuration-resilience` (per-attempt timeout and retry policy).
