//! Lianki desktop shell.
//!
//! This is deliberately a thin window around the hosted web app: the Next.js
//! server (route handlers, better-auth, D1) cannot be bundled into a Tauri
//! binary, so the window loads `https://lianki.com` directly and the service
//! worker the site already ships handles the offline fallback. No IPC is
//! exposed to the page — the only native behaviour is the navigation policy
//! below.

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// Where the window starts: the app itself (`/list`, the same entry the PWA
/// manifest uses), not the marketing landing page. `LIANKI_URL` overrides it
/// for local development (`LIANKI_URL=http://localhost:3000/list bun run dev`).
fn start_url() -> Url {
  let raw = std::env::var("LIANKI_URL").unwrap_or_else(|_| "https://lianki.com/list".into());
  Url::parse(&raw).unwrap_or_else(|e| panic!("LIANKI_URL {raw:?} is not a URL: {e}"))
}

/// Hosts the embedded webview may navigate to. Everything else opens in the
/// user's default browser so the app never becomes a general-purpose browser.
///
/// The OAuth hosts are here because better-auth's social sign-in redirects
/// through them and back to `/api/auth/callback/*`; a sign-in that bounced out
/// to the system browser would leave the session cookie in the wrong place.
fn is_in_app_host(host: &str, start: &Url) -> bool {
  if start.host_str().is_some_and(|h| h == host) {
    return true;
  }
  const HOSTS: &[&str] = &["lianki.com", "www.lianki.com"];
  const SUFFIXES: &[&str] = &[".google.com", ".googleusercontent.com", ".github.com"];
  HOSTS.contains(&host)
    || host == "accounts.google.com"
    || host == "github.com"
    || SUFFIXES.iter().any(|s| host.ends_with(s))
}

fn allow_navigation(app: &AppHandle, start: &Url, url: &Url) -> bool {
  let scheme = url.scheme();
  if scheme == "about" || scheme == "blob" || scheme == "data" {
    return true;
  }
  if matches!(scheme, "http" | "https") && url.host_str().is_some_and(|h| is_in_app_host(h, start)) {
    return true;
  }
  log::info!("opening externally: {url}");
  if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
    log::warn!("could not open {url} in the system browser: {e}");
  }
  false
}

/// `target="_blank"` links would otherwise ask the webview for a new window,
/// which a single-window shell has no good answer for. Route them through the
/// same-window navigation so `allow_navigation` decides in-app vs external.
const INIT_SCRIPT: &str = r#"
(() => {
  const open = window.open.bind(window);
  window.open = (url, target, features) => {
    if (url && (!target || target === "_blank")) {
      window.location.assign(new URL(String(url), window.location.href).href);
      return null;
    }
    return open(url, target, features);
  };
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a || a.target !== "_blank" || e.defaultPrevented) return;
    e.preventDefault();
    window.location.assign(a.href);
  }, true);
})();
"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
      }
    }))
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app
          .handle()
          .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
      }
      let start = start_url();
      let handle = app.handle().clone();
      let nav_start = start.clone();
      WebviewWindowBuilder::new(app, "main", WebviewUrl::External(start))
        .title("Lianki")
        .inner_size(1100.0, 760.0)
        .min_inner_size(480.0, 400.0)
        .initialization_script(INIT_SCRIPT)
        .on_navigation(move |url| allow_navigation(&handle, &nav_start, url))
        .build()?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running the Lianki desktop shell");
}
