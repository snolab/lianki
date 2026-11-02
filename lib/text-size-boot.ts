/** The range of a text scale (lib/text-size.ts). */
export const TEXT_MIN = 0.85;
export const TEXT_MAX = 1.5;

/**
 * The inline script app/layout.tsx runs before first paint for Text size
 * (lib/text-size.ts): the stored choices, read raw (persist JSON
 * `{state, version}` under `lk:pref:text-size`), as `--lk-fs-<area>` on
 * `<html>`. No imports: the root layout is a server component.
 */
export const TEXT_SIZE_BOOT_SCRIPT = `try{var t=JSON.parse(localStorage.getItem("lk:pref:text-size")||"null");if(t&&t.version===1&&t.state)["ui","chat","cards"].forEach(function(a){var v=t.state[a];if(typeof v==="number"&&v>=${TEXT_MIN}&&v<=${TEXT_MAX}&&v!==1)document.documentElement.style.setProperty("--lk-fs-"+a,String(v))})}catch(e){}`;
