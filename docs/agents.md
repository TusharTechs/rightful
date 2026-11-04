# Filing claims from an AI assistant

Rightful lets a person's assistant do the paperwork of a claim. It never lets the assistant be the
one who gets paid.

- The assistant can **find programs, file a claim, follow it, and fetch the payout receipt**.
- It **cannot confirm, decide or pay** a claim. No tool or endpoint lets it; `test/mcp.test.ts` pins
  the tool list.
- Every claim it files starts **unbound** and comes back with `humanConfirmationRequired: true` and a
  `bindUrl`. The person opens that link, signs in with PayPal, checks the claim and confirms it.
  Payment goes only to the PayPal account that confirmed it (`recipient_type: PAYPAL_ID`).
- Filings are limited per network (/24) and program: 30 unconfirmed claims an hour.

## MCP

Streamable HTTP, stateless, at `https://rightful-api.onrender.com/mcp`.

```json
{
  "mcpServers": {
    "rightful": { "type": "http", "url": "https://rightful-api.onrender.com/mcp" }
  }
}
```

| Tool | What it does |
| --- | --- |
| `list_programs` | Open programs, with pool, closing time and the eligibility statement |
| `get_program` | One program and its claim counts by status |
| `file_claim` | Files one claim (`programId`, `email`, `address`, `narrative`, optional `agentName`); returns the `bindUrl` for the person |
| `claim_status` | Where a claim stands, and `statusUrl`: the person's own page for following it (and asking for a review if it is held); no personal data and no PayPal identifiers |
| `get_receipt` | For a paid claim: the payout, its Merkle path to the ledger root, the digest on the PayPal payment note, and a receipt link anyone can check |

The `agentName` an assistant gives is shown to the program administrator next to its claims. It
is a label, not an identity: nothing is trusted because of it.

## Plain HTTP

The same filing path, the same limit. The full contract is OpenAPI 3.1 at
[`/openapi.json`](https://rightful-api.onrender.com/openapi.json), generated from the same schemas
the MCP tools use (`src/api/contract.ts`); a test fails if a documented route or response drifts.

```bash
curl -X POST https://rightful-api.onrender.com/api/programs/<programId>/claims \
  -H 'content-type: application/json' \
  -d '{"email":"…","address":"…","narrative":"…","agentName":"My Assistant"}'
```
