// @intlayer/dictionaries-entry, aliased here by next.config.mjs (browser and
// server alike). The real entry imports every dictionary in all 16 locales:
// 2.3 MB of JS on every page, and three ~5 MB copies in the Worker, whose
// isolate then held more than Workers' 128 MB before it served anything
// (docs/cold-start.md, "Server render on a cold isolate").
//
// Nothing looks a dictionary up by key any more: every useIntlayer("key") and
// getIntlayer("key") is rewritten into a direct import of that dictionary
// (lib/build/intlayer-direct-loader.cjs), and unit/intlayer-direct-loader.test.ts
// holds that no file is left that would need the lookup.
const dictionaries = {};
const getDictionaries = () => dictionaries;

export { getDictionaries };
export default dictionaries;
