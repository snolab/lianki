// @intlayer/unmerged-dictionaries-entry, aliased here by next.config.mjs.
//
// Only intlayer's visual editor imports it (react-intlayer's
// IntlayerEditorProvider, and only while the editor is enabled). Lianki does
// not configure the editor, so that import never ran, yet the real entry — every
// dictionary, unmerged, in all 16 locales — sat in the Worker (5.7 MB) and in a
// browser chunk. An empty table keeps the editor working with nothing to edit.
const dictionaries = {};
const getUnmergedDictionaries = () => dictionaries;

export { getUnmergedDictionaries };
export default dictionaries;
