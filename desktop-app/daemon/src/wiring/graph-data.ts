/**
 * The named stores, as the one adapter both halves of the app use.
 *
 * Two things reach for shared data — the `store-*` graph nodes and a plugin's `data.*` methods — and
 * they have to be reaching for the *same* rows or the feature is a lie. One factory rather than an
 * adapter beside each caller is what makes that structural: there is no second place to add a
 * prefix, a size cap or a transaction to and forget the other.
 *
 * The seam itself is deliberately six methods and no `Store`. See `graphs/builtins/data-store.ts`.
 */

import type { GraphDataStore } from "../graphs/builtins/data-store.ts";
import type { Store } from "../store/index.ts";

export function createGraphData(store: Store): GraphDataStore {
  return {
    get: (name, collection, key) => store.getGraphKv(name, collection, key),
    // `putGraphKv` creates the store row on the way past. Reads never do: a read from a store
    // nobody has written to is legitimately empty, and creating one there would fill the Stores
    // panel with names that came from typos.
    put: (name, collection, key, value) => {
      store.putGraphKv(name, collection, key, value);
    },
    remove: (name, collection, key) => {
      store.deleteGraphKv(name, collection, key);
    },
    list: (name, collection) => store.listGraphKv(name, collection),
    count: (name, collection) => store.countGraphKv(name, collection),
    clear: (name, collection) => {
      store.clearGraphKvCollection(name, collection);
    },
  };
}
