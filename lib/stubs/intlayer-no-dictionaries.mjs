// The browser's @intlayer/dictionaries-entry (next.config.mjs aliases it here
// for browser code only). The real entry imports every dictionary in all 16
// locales — 2.3 MB of JS that next-intlayer's barrel pulled into every page.
//
// Browser code never looks a dictionary up by key: every useIntlayer("key")
// is rewritten into a direct import of that dictionary
// (lib/build/intlayer-direct-loader.cjs), and unit/intlayer-direct-loader.test.ts
// holds that no client file is left that would need the lookup. Server
// rendering keeps the real entry.
const dictionaries = {};
const getDictionaries = () => dictionaries;

export { getDictionaries };
export default dictionaries;
