# HEB Shopping List API — discovered surface

Output of **W0**. Captured 2026-08-01 against a real logged-in account by driving
heb.com in Playwright and recording GraphQL traffic (`tools/drive.ts`).

Unofficial. H-E-B publishes no API and none of this is guaranteed stable.

- **Endpoint:** `POST https://www.heb.com/graphql`
- **Auth:** cookies (see [Session](#session))
- **Required headers:** `Content-Type: application/json`, `Origin: https://www.heb.com`,
  `Referer: https://www.heb.com/shopping-list`, a browser-like `User-Agent`
- **Next.js buildId at capture:** `e3a12b41746b3f5bb71ba49ebe302e1f69cf8009`

## ⚠️ Three findings that changed the design

### 1. A plain HTTP client works. No browser needed for requests.

`fetch()` from Node with the captured cookie jar returns real data. Imperva does not
require an ongoing browser. The browser is needed **only to obtain the session**, not to
use it.

### 2. APQ is **non-strict** — arbitrary queries are accepted

Sending a novel query with its own hash executes normally:

```jsonc
// request
{ "operationName": "ProbeTypename", "query": "query ProbeTypename { __typename }",
  "variables": {}, "extensions": { "persistedQuery": { "version": 1, "sha256Hash": "<sha256 of query>" }}}
// response
{ "data": { "__typename": "Query" } }
```

**Consequences:** persisted-query hashes are optional. We send our own query text and
request exactly the fields we need instead of HEB's very large page queries.

**This turned out to be necessary, not merely nice.** HEB's persisted store is a *cache,
not a safelist*: `deleteShoppingListItemsV2` worked in the browser and then returned
`PersistedQueryNotFound` from a byte-correct hash minutes later — the entry had been
evicted. Hash-only requests are least reliable for the operations used least often, which
is the worst possible failure distribution. Sending query text removes the dependency.

### 2a. Introspection is disabled — but the validator is chatty

`{"errors":[{"extensions":{"code":"INTROSPECTION_DISABLED"}}]}`. Type names for variable
declarations are therefore unavailable, so queries **inline their literals** instead
(no `$variables`, no type names required). Enum-valued fields must be **unquoted**:
`sort: CATEGORY`, not `sort: "CATEGORY"`.

The validator is the schema documentation that's left. Asking for nothing names what is
required:

```
Field "productSearchItems" argument "params" of type "SearchPageParamsV2!" is required…
Field "productSearchItems" argument "searchPageLayout" of type "SearchPageLayout!" is required…
Field "SearchPageParamsV2.shoppingContext" of required type "ShoppingContext!" was not provided.
```

### 2b. Almost every return type is a union

This is the single biggest gotcha. Selecting fields directly fails with *"must have a
selection of subfields"*; every selection needs an inline fragment on the concrete type.

| Field | Returns | Concrete member |
|---|---|---|
| `getShoppingListsV2` | wrapper union | `ShoppingListsWithHeaderPageV2` |
| `getShoppingListV2` | `ShoppingListResponseV2` | `ShoppingListV2` |
| `addShoppingListItemsV2` | `ShoppingListResponseV2` | `ShoppingListV2` |
| `updateShoppingListItemV2` | `ShoppingListResponseV2` | `ShoppingListV2` |
| `deleteShoppingListItemsV2` | `ShoppingListResponseV2` | `ShoppingListV2` |
| `productSearchItems` | wrapper union | `ProductSearchItemsResult` |
| `SearchGridV2.items` | `SearchGridItem` | `Product` |
| `ShoppingListItemPageV2.items` | union | `ProductShoppingListItemV2` |

### 3. Session cookies are long-lived, not ~11 minutes

The OSS reference project's README claims bot detection "expires every ~11 minutes". The
actual cookie TTLs on a fresh capture:

| Cookie | Host | TTL |
|---|---|---|
| `reese84` | `.heb.com` | **720h (30d)** |
| `reese84` | `accounts.heb.com` | 719.8h (30d) |
| `sat` | `www.heb.com` | 1439.8h (60d) |
| `sst`, `sst.sig` | `www.heb.com` | 8765.8h (365d) |
| `_session*` | `accounts.heb.com` | 719.8h (30d) |
| `HEB_SHOPPING_LIST` | `www.heb.com` | 8759.8h (365d) |
| `visid_incap_*` | both | ~8736h (364d) |

Whether Imperva *server-side* invalidates `reese84` sooner than its cookie TTL is being
measured by `tools/soak.ts`; see [Open questions](#open-questions). Until that says
otherwise, treat the 11-minute figure as unconfirmed for a cookie-only HTTP client.

## Session

Auth spans **two hosts** — capturing only the storefront looks fine and then fails.

| Host | Load-bearing cookies |
|---|---|
| `www.heb.com` | `sat`, `sst`, `sst.sig`, `HEB_SHOPPING_LIST` |
| `accounts.heb.com` | `_session`, `_session.sig`, `_session.legacy`, `_session.legacy.sig` |
| `.heb.com` | `reese84`, `visid_incap_*` |

Login is an OIDC provider (`accounts.heb.com/interaction/{uid}/login`, the
`node-oidc-provider` URL shape) offering password, emailed one-time code, and passkey.
The latter two cannot be replayed headlessly, so **re-login requires a human**.

## Account shape at capture

> **Redaction policy.** This document is committed, so it carries no real identifiers.
> List ids, item ids, and store numbers are account- and location-identifying, and appear
> here only as `<listId>`, `<lineId>`, `<storeId>`. The real values live in `captures/`,
> which is gitignored.

The account had exactly **one** list, which makes default-list resolution trivial (the
"sole list" rule in the plan's §4.2 is sufficient; no `HEB_LIST_ID` config is needed yet).
Its metadata: `role: ADMIN`, `shoppingListVisibilityLevel: PRIVATE`, and a
`fulfillment.store` with a `storeNumber` and name.

Note the **list store and the shopping store are independent** — the site header advertised
a different store from the one the list belonged to. Product search takes its own
`storeId`, so the two must be reconciled deliberately rather than assumed equal.

## Operations

⚠️ **The mutation *field* names differ from the operation names the browser sends.** The
site sends `operationName: "deleteShoppingListItems"` but the schema field is
`deleteShoppingListItemsV2`. Use the field names below, not the captured operation names.

| Operation name (browser) | Schema field |
|---|---|
| `addToShoppingListV2` | `addShoppingListItemsV2` |
| `updateShoppingListItem` | `updateShoppingListItemV2` |
| `deleteShoppingListItems` | `deleteShoppingListItemsV2` |

Persisted hashes below are what the site used on the capture date. They are recorded for
reference only — the client no longer uses them (see finding #2).

| Operation | Kind | sha256Hash |
|---|---|---|
| `getShoppingListsV2` | read all lists | `35da893a3476a098d44f8d6ac379db3129117b977d4df4dcbe48a5641eb9fdd5` |
| `getShoppingListV2` | read one list | `be7ef9cbde1681126eb189e3a362aef969794a7e3dc7bbd046ff6a9adb1dadad` |
| `addToShoppingListV2` | add items | `39076b06f05b5427a458e1a35f4946e63c021df56a40556bc8eee23ba4100c5a` |
| `updateShoppingListItem` | set quantity | `c30445bde42a85d482cce7427989b6ff27ecfc95ed5a484e9021ec8601da28e0` |
| `deleteShoppingListItems` | remove items | `be69093d13eec3d8297cfa6be524fde8bc2d4e4917249574ff1b8159efa61019` |
| `productSearchItems` | full search | `3f570fe817d24c0b1e559d344ef0fce61dfa9db3dbc66ba69ad5d8e1f7aee609` |
| `typeaheadContent` | typeahead | `afc2f7f3ccdeb46ea759d6951875e93a1487c3cd8ebc2c9c876fbf2c3c705bf3` |

Incidental, captured but unused: `ShopNavigation`, `ShoppingStore`, `cartEstimated`,
`alertEntryPoint`, `getBuyItAgainCarousel`.

> `alertEntryPoint`'s hash is byte-identical to the one hardcoded in `texas-grocery-mcp`,
> while `ShopNavigation` and `cartEstimated` have both drifted. Hashes do rot, just
> unevenly — which is why finding #2 matters.

### Read

```jsonc
// getShoppingListsV2 — no variables
{}

// getShoppingListV2
{ "input": { "id": "<listId>",
             "page": { "page": 0, "size": 500, "sort": "CATEGORY", "sortDirection": "ASC" } } }
```

### Add — `addToShoppingListV2`

```jsonc
{ "input": { "listId": "<listId>",
             "listItems": [ { "item": { "productId": "2242160" } } ],
             "page": { "sort": "CATEGORY", "sortDirection": "ASC" } } }
```

`listItems` is an array, so **batch adds are supported in one call**. Note the response
field is `addShoppingListItemsV2`, which does *not* match the operation name.

### Update quantity — `updateShoppingListItem`

```jsonc
{ "input": { "itemId": "<lineId>", "listId": "<listId>",
             "quantityOrWeight": { "quantity": 1 },
             "page": { "sort": "CATEGORY", "sortDirection": "ASC" } } }
```

`quantityOrWeight` implies a weight-based variant for by-the-pound goods — not yet captured.

### Remove — `deleteShoppingListItems`

```jsonc
{ "input": { "itemIds": ["<lineId>"], "listId": "<listId>",
             "page": { "sort": "CATEGORY", "sortDirection": "ASC" } } }
```

Also batched. In the UI this sits behind a confirmation dialog; the mutation only fires
after confirming.

### Search — `productSearchItems`

```jsonc
{ "params": { "query": "oat milk", "storeId": <storeId>, "pageIndex": 0, "pageSize": 60,
              "sortBy": "SCORE", "sortDirection": "DESC",
              "shoppingContext": "EXPLORE_MY_STORE", "addressAllowAlcohol": false },
  "storeId": <storeId>, "shoppingContext": "EXPLORE_MY_STORE",
  "searchMode": "SHOPPING_LIST_SEARCH", "searchPageLayout": "MOBILE_WEB_SEARCH_PAGE_LAYOUT" }
```

`searchMode: "SHOPPING_LIST_SEARCH"` is the list-oriented ranking — the right mode for us.

## List item shape

From an `addToShoppingListV2` response:

```jsonc
{ "id": "<lineId>",  // the lineId used by update/delete
  "quantity": 1, "checked": false, "note": null, "weight": null,
  "maximumQuantity": 20, "groupHeader": "Dairy & eggs",
  "itemPrice": { "totalAmount": 5.27, "listPrice": 5.27, "onSale": false } }
```

### Answers to the contract questions

| Question | Answer |
|---|---|
| Is quantity a line property or are duplicates separate lines? | **A line property.** Confirms the plan's duplicate rule: increment, don't add a second line. |
| What identifies a line for removal? | The item `id` (UUID) — maps to `ListItem.lineId`. |
| Free-text items? | **Not via this path.** Add requires a catalog `productId`. There is a `note` field per line and an "Add note" UI control, but that annotates an existing product rather than creating a text-only item. `ListItem.product` may therefore be non-nullable — pending a check of HEB's mobile "Siri to List" path. |

Also worth honouring: `maximumQuantity` (20 here) is a real server-side bound.

## Free-text lines

H-E-B offers `Add "<what you typed>" to list` as soon as its search box has text — in the
app *and* on the web, in the "Add items" drawer. It is the same `addShoppingListItemsV2`
mutation as a product add, with a different item shape:

```graphql
addShoppingListItemsV2(input: {
  listId: "<listId>"
  listItems: [{ item: { genericName: "what you typed" } }]
  page: { sort: CATEGORY, sortDirection: ASC }
})
```

Two traps, both found the hard way:

- The browser's **operation name** is `addToShoppingListV2`; the **schema field** is
  `addShoppingListItemsV2`. Sending the capture verbatim fails validation.
- These come back as `GenericShoppingListItemV2` with the text in **`genericName`**, not
  `note`. `note` is H-E-B's separate "Add note" annotation and is null even on text lines,
  so reading it instead silently drops every free-text line from the list.

## Weight-based items

Counter goods — deli meat and cheese sliced to order, seafood — are priced per pound.

| Field | Type | Where |
|---|---|---|
| `pricedByWeight` | `Boolean` | `Product` |
| `weightSelectionIncrements` | `[Float]` | `Product.SKUs[]` |
| `weight` | `Float` | `ProductShoppingListItemV2` |
| `QuantityOrWeightInputV2` | `{ quantity, weight: Float }` | update input |

Set one with the ordinary update mutation:

```graphql
updateShoppingListItemV2(input: {
  itemId: "<lineId>"  listId: "<listId>"
  quantityOrWeight: { weight: 2 }
  page: { sort: CATEGORY, sortDirection: ASC }
})
```

`weightSelectionIncrements` is a **closed ladder**, not a step size — 0.25-lb rungs at this
store — and an off-ladder weight is refused, so snap onto it before writing.

Note what `pricedByWeight` is *not*: a name that quotes a weight. "H-E-B Natural Boneless
Chicken Breasts, Avg. 2.85 lbs" is `false` — one package. Only counter goods are `true`.
A field-name sweep (`isWeighted`, `soldByWeight`, `unitOfMeasure`, `salesUom`, …) found
none of them; these names came from HEB's own captured responses.

## Open questions

1. **Does a cookie-only session survive past ~11 minutes?** Being measured by
   `tools/soak.ts` → `captures/soak.log`. This single answer decides whether the refresher
   is a 10-minute Playwright cycle or an occasional top-up.
2. **Reconciling list store vs. shopping store** when they differ.

## Reproducing

```bash
npm run capture                      # log in by hand; profile persists
npx tsx tools/drive.ts inspect       # dump the list page's controls
npx tsx tools/drive.ts add "oat milk"
npx tsx tools/drive.ts mutate        # quantity increment/decrement
npx tsx tools/drive.ts remove
npx tsx tools/experiments.ts         # the three findings above
npx tsx tools/soak.ts 120            # session longevity
```

Raw captures land in `captures/` — **gitignored, contains live cookies.**
