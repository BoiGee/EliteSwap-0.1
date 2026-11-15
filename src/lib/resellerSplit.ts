// Pure money math for the reseller program, kept free of imports so tests (and CI, which has no
// Supabase env during `npm test`) can load it without the Supabase client.

/**
 * Elite Swap's share of a sale: the list price plus half the reseller's markup. Same rounding as
 * reseller_record_sale() (a half cent goes to Elite Swap), worked in whole cents so the preview
 * never drifts from what the server charges.
 */
export function splitSale(listUsd: number, priceUsd: number) {
  const list = Math.round(listUsd * 100);
  const price = Math.round(priceUsd * 100);
  const platform = list + Math.round((price - list) / 2);
  return { platform: platform / 100, reseller: (price - platform) / 100 };
}
