/**
 * The inline script app/layout.tsx runs before first paint for "Turn off
 * animations" (lib/motion-pref.ts): the stored choice, read raw (zustand's
 * persist JSON, `{state, version}` under `lk:pref:motion`), as
 * `<html data-motion="off">`. No imports: the root layout is a server component.
 */
export const MOTION_BOOT_SCRIPT = `try{var m=JSON.parse(localStorage.getItem("lk:pref:motion")||"null");if(m&&m.state&&m.state.animations==="off")document.documentElement.dataset.motion="off"}catch(e){}`;
