/**
 * Bundle dependencies for lianki.user.js
 * This creates a standalone bundle with ts-fsrs + idb-keyval
 */

import {
  fsrs,
  generatorParameters,
  Rating,
  type Card,
  type ReviewLog,
  type RecordLog,
} from "ts-fsrs";
import { createStore, get, set, keys, del, clear } from "idb-keyval";

// Re-export everything needed by userscript
export {
  // ts-fsrs
  fsrs,
  generatorParameters,
  Rating,
  type Card,
  type ReviewLog,
  type RecordLog,
  // idb-keyval
  createStore,
  get,
  set,
  keys,
  del,
  clear,
};
