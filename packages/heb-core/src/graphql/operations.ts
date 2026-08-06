/**
 * Hand-written GraphQL documents for the operations we need.
 *
 * ── Why not persisted-query hashes ──────────────────────────────────────────────────
 * HEB's APQ is *non-strict*, which means its persisted-query store is a **cache, not a
 * safelist**. That was proven the hard way: `deleteShoppingListItemsV2` worked in the
 * browser and returned `PersistedQueryNotFound` from a correct hash minutes later — the
 * entry had been evicted. Hash-only requests are therefore least reliable for exactly the
 * operations we use least often, which is the worst possible failure distribution.
 *
 * Sending our own query text removes that dependency entirely. It also lets us request the
 * handful of fields the contracts need instead of HEB's very large page queries.
 *
 * ── Why literals instead of variables ───────────────────────────────────────────────
 * Introspection is disabled, so input *type names* (needed for `query Q($input: X!)`) are
 * unavailable. Inlining literals sidesteps that — verified against the live API, including
 * that enum-valued fields must be **unquoted** (`sort: CATEGORY`, not `sort: "CATEGORY"`).
 *
 * ── Union returns ───────────────────────────────────────────────────────────────────
 * List mutations return `ShoppingListResponseV2`, whose success member is `ShoppingListV2`,
 * so every selection goes through an inline fragment. Selecting fields directly fails with
 * "must have a selection of subfields".
 *
 * Schema facts verified 2026-08-01 against buildId e3a12b41746b3f5bb71ba49ebe302e1f69cf8009.
 */

export interface GraphqlDocument {
  operationName: string;
  query: string;
}

/**
 * Encode a value as a GraphQL string literal.
 *
 * `JSON.stringify` is exactly right here: GraphQL string syntax is a subset of JSON's, so
 * quotes, backslashes, and control characters all escape correctly. This is what keeps a
 * spoken search term from breaking out of the query.
 */
function str(value: string): string {
  return JSON.stringify(value);
}

function strList(values: readonly string[]): string {
  return `[${values.map(str).join(', ')}]`;
}

/**
 * How a product declares that it is sold by the pound.
 *
 * `pricedByWeight` is true for counter goods — deli meat and cheese sliced to order,
 * seafood — and false for everything packaged, *including* items whose name quotes a
 * weight ("Boneless Chicken Breasts, Avg. 2.85 lbs" is one package, not 2.85 units).
 * `weightSelectionIncrements` is the ladder H-E-B will accept, in pounds; at this store
 * it is 0.25-lb steps. Asking for a weight off the ladder is rejected, so it is the
 * authority on both the step and the minimum and maximum.
 *
 * Recovered from HEB's own captured responses after a field-name sweep found nothing —
 * guessing at `isWeighted`/`soldByWeight`/`unitOfMeasure` was wrong on all counts.
 */
const WEIGHT_FIELDS = 'pricedByWeight SKUs { weightSelectionIncrements }';

/** Sort applied to every list read. CATEGORY groups items the way the HEB app does. */
const PAGE = '{ sort: CATEGORY, sortDirection: ASC }';

/** Read a whole list in one call; HEB's own client uses 500. */
const LIST_PAGE_SIZE = 500;

/** Matches the site's own page size so relevance ranking behaves identically. */
export const SEARCH_PAGE_SIZE = 60;

/**
 * The fields we consume from a list. Deliberately small — this is the payload on the Alexa
 * critical path, where the whole budget is ~8 seconds.
 *
 * `items` are `ProductShoppingListItemV2`; the inline fragment leaves room for HEB to add
 * other item kinds without breaking the query.
 */
const LIST_FIELDS = `
  id
  name
  totalItemCount
  fulfillment { store { storeNumber } }
  itemPage {
    items {
      __typename
      ... on ProductShoppingListItemV2 {
        id
        quantity
        maximumQuantity
        # Pounds, for a line whose product is sold at the deli or seafood counter.
        # Null on everything else — an ordinary packaged good has a quantity, not a weight.
        weight
        # H-E-B keeps checked-off lines on the list rather than deleting them. Without this,
        # a completed product line is indistinguishable from an active one, so it keeps
        # showing up as still needed.
        checked
        product { id fullDisplayName brand { name } ${WEIGHT_FIELDS} }
      }
      # Free-text lines. HEB's mobile app offers 'Add "<what you typed>" to your list'
      # for an unmatched search, and those lines come back as this member with the text
      # in \`genericName\` and no product at all. (\`note\` is a *separate* annotation,
      # the "Add note" button in HEB's UI, and is normally null.) Omitting the fragment
      # does not omit the item —
      # it arrives with only a __typename and is silently dropped, so Alexa and MCP
      # under-report a list that the H-E-B app shows correctly.
      ... on GenericShoppingListItemV2 {
        id
        quantity
        genericName
        note
        checked
      }
    }
  }
`;

/** List mutations return a union; unwrap it consistently. */
const listResult = (field: string): string =>
  `${field} { __typename ... on ShoppingListV2 { ${LIST_FIELDS} } }`;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getShoppingListsDocument(): GraphqlDocument {
  return {
    operationName: 'HebGetShoppingLists',
    // Like the mutations, this returns a wrapper union — selecting `lists` directly fails
    // with "must have a selection of subfields".
    query: `query HebGetShoppingLists {
      getShoppingListsV2 {
        __typename
        ... on ShoppingListsWithHeaderPageV2 {
          lists {
            id
            name
            totalItemCount
            fulfillment { store { storeNumber } }
          }
        }
      }
    }`,
  };
}

export function getShoppingListDocument(listId: string): GraphqlDocument {
  return {
    operationName: 'HebGetShoppingList',
    query: `query HebGetShoppingList {
      getShoppingListV2(input: {
        id: ${str(listId)}
        page: { page: 0, size: ${LIST_PAGE_SIZE}, sort: CATEGORY, sortDirection: ASC }
      }) { __typename ... on ShoppingListV2 { ${LIST_FIELDS} } }
    }`,
  };
}

/**
 * Products the account buys regularly — HEB's own "Buy it again" carousel.
 *
 * Used as a *ranking* signal only: among products the words cannot separate, something
 * already bought before is far more likely to be the one meant. It never affects
 * confidence, so a familiar brand can never win against a better match.
 *
 * Signature per the validator: getBuyItAgainCarousel(storeId: ID!, shoppingContext:
 * ShoppingContext!), returning a union whose success member is `Carousel`. Its `items`
 * field takes the same two arguments again, this time with storeId as an Int.
 */
export function buyItAgainDocument(storeId: number): GraphqlDocument {
  return {
    operationName: 'HebBuyItAgain',
    query: `query HebBuyItAgain {
      getBuyItAgainCarousel(storeId: ${str(String(storeId))}, shoppingContext: EXPLORE_MY_STORE) {
        __typename
        ... on Carousel {
          items(storeId: ${storeId}, shoppingContext: EXPLORE_MY_STORE) {
            __typename
            ... on Product { id }
          }
        }
      }
    }`,
  };
}

export function searchProductsDocument(query: string, storeId: number): GraphqlDocument {
  return {
    operationName: 'HebSearchProducts',
    // Signature per the validator: productSearchItems(params: SearchPageParamsV2!,
    // searchPageLayout: SearchPageLayout!). The capture's other six top-level values were
    // GraphQL *variables* HEB's own document consumed elsewhere — not field arguments.
    query: `query HebSearchProducts {
      productSearchItems(
        params: {
          query: ${str(query)}
          storeId: ${storeId}
          shoppingContext: EXPLORE_MY_STORE
          pageIndex: 0
          pageSize: ${SEARCH_PAGE_SIZE}
          sortBy: SCORE
          sortDirection: DESC
        }
        searchPageLayout: MOBILE_WEB_SEARCH_PAGE_LAYOUT
      ) {
        __typename
        ... on ProductSearchItemsResult {
          searchGrid {
            total
            items {
              __typename
              ... on Product { id fullDisplayName brand { name } ${WEIGHT_FIELDS} }
            }
          }
        }
      }
    }`,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Add a free-text line — the "Add \"<what you typed>\" to list" affordance.
 *
 * Same mutation as a product add; only the item shape differs — `genericName` where a
 * product add sends `productId`. Captured from the web drawer, which offers this as soon
 * as the search box has text.
 *
 * The capture's operation name is `addToShoppingListV2`, but that is the *browser's* name
 * for the document, not the schema field — sending it verbatim fails validation with
 * `Cannot query field "addToShoppingListV2" on type "Mutation"`. The field is
 * `addShoppingListItemsV2`, the same one a product add uses (§2.1: operation names and
 * field names differ).
 */
export function addTextDocument(listId: string, text: string): GraphqlDocument {
  return {
    operationName: 'HebAddShoppingListText',
    query: `mutation HebAddShoppingListText {
      ${listResult(`addShoppingListItemsV2(input: {
        listId: ${str(listId)}
        listItems: [{ item: { genericName: ${str(text)} } }]
        page: ${PAGE}
      })`)}
    }`,
  };
}

export function addItemsDocument(listId: string, productIds: readonly string[]): GraphqlDocument {
  // `listItems` is an array, so batch adds cost one round trip rather than N.
  const items = productIds.map((id) => `{ item: { productId: ${str(id)} } }`).join(', ');
  return {
    operationName: 'HebAddShoppingListItems',
    query: `mutation HebAddShoppingListItems {
      ${listResult(`addShoppingListItemsV2(input: {
        listId: ${str(listId)}
        listItems: [${items}]
        page: ${PAGE}
      })`)}
    }`,
  };
}

export function updateItemQuantityDocument(
  listId: string,
  itemId: string,
  quantity: number,
): GraphqlDocument {
  return {
    operationName: 'HebUpdateShoppingListItem',
    query: `mutation HebUpdateShoppingListItem {
      ${listResult(`updateShoppingListItemV2(input: {
        itemId: ${str(itemId)}
        listId: ${str(listId)}
        quantityOrWeight: { quantity: ${Math.trunc(quantity)} }
        page: ${PAGE}
      })`)}
    }`,
  };
}

/**
 * Set a line's weight, in pounds — the counter-goods counterpart of the quantity update.
 *
 * `QuantityOrWeightInputV2` carries both `quantity` and `weight` (verified against the
 * validator, which named the type); which one applies is a property of the product, not
 * of the caller. Callers must snap `pounds` onto the product's
 * `weightSelectionIncrements` first — an off-ladder value is refused.
 */
export function updateItemWeightDocument(
  listId: string,
  itemId: string,
  pounds: number,
): GraphqlDocument {
  return {
    operationName: 'HebUpdateShoppingListItemWeight',
    query: `mutation HebUpdateShoppingListItemWeight {
      ${listResult(`updateShoppingListItemV2(input: {
        itemId: ${str(itemId)}
        listId: ${str(listId)}
        quantityOrWeight: { weight: ${pounds} }
        page: ${PAGE}
      })`)}
    }`,
  };
}

export function deleteItemsDocument(
  listId: string,
  itemIds: readonly string[],
): GraphqlDocument {
  return {
    operationName: 'HebDeleteShoppingListItems',
    query: `mutation HebDeleteShoppingListItems {
      ${listResult(`deleteShoppingListItemsV2(input: {
        itemIds: ${strList(itemIds)}
        listId: ${str(listId)}
        page: ${PAGE}
      })`)}
    }`,
  };
}

/** Response field names, which differ from the operation names above. */
export const RESULT_FIELDS = {
  getShoppingLists: 'getShoppingListsV2',
  getShoppingList: 'getShoppingListV2',
  addItems: 'addShoppingListItemsV2',
  updateItem: 'updateShoppingListItemV2',
  deleteItems: 'deleteShoppingListItemsV2',
  searchProducts: 'productSearchItems',
} as const;
