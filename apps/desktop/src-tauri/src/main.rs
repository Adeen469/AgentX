#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! AgentX desktop shell (Tauri).
//!
//! Mirrors the old Electron `main.js`: a single 1440x900 window that loads
//! the web app at `$AGENTX_WEB_URL` (default `http://localhost:3000`). The
//! shell is a viewer only — it adds no server, auth, or sandbox of its own.
//!
//! Behaviour map (Electron -> Tauri):
//! - `BrowserWindow` 1440x900, min 1100x700 -> `WebviewWindowBuilder`
//!   with the same sizes. The window is created in `setup` (not from
//!   `tauri.conf.json`) because the URL comes from an environment variable
//!   at runtime, which the config file cannot read.
//! - `window.loadURL(...).catch(...)` -> the URL is parsed before the
//!   window is created; an unparseable URL shows a native error dialog
//!   and exits. A load failure of a well-formed URL has no Tauri
//!   equivalent callback: WebView2 shows its own built-in error page and
//!   the window stays open, so there is nothing to hook here.
//! - `render-process-gone` -> no Tauri/WebView2 equivalent exists. There
//!   is no renderer-crash callback to hook; WebView2 shows its own crash
//!   page and the app stays alive. This case is knowingly not mirrored.
//! - `setWindowOpenHandler` + `shell.openExternal` -> `on_navigation`:
//!   any navigation away from the app origin is denied in the webview
//!   and opened in the system browser via the opener plugin, EXCEPT
//!   `github.com`, which must stay in the webview so the GitHub OAuth
//!   flow (state cookie + callback) works.
//! - `uncaughtException` / `unhandledRejection` -> a Rust panic hook
//!   that logs to stderr and, if the app handle is available, shows a
//!   native error dialog. (There is no JS main process in Tauri, so
//!   there is no unhandled-rejection event to mirror.)
//! - `app.setAppUserModelId("com.agentx.desktop")` -> Tauri sets the
//!   Windows app user model id from the `identifier` in
//!   `tauri.conf.json` (`com.agentx.desktop`) automatically; there is no
//!   separate call to make.
//! - `window-all-closed` -> Tauri's default: the app exits when the last
//!   window closes on Windows/Linux and stays resident on macOS, which
//!   is exactly what the Electron code did.

use std::sync::OnceLock;

use tauri::{AppHandle, WebviewUrl};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

/// App handle kept for the panic hook, so a Rust panic can still surface a
/// native error dialog (the Electron `uncaughtException` equivalent).
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

fn show_error(app: &AppHandle, title: &str, message: &str) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

/// The web app URL: `$AGENTX_WEB_URL`, default `http://localhost:3000`
/// (same as the old Electron shell).
fn web_url() -> Result<url::Url, String> {
    let raw = std::env::var("AGENTX_WEB_URL")
        .unwrap_or_else(|_| "http://localhost:3000".to_string());
    raw.parse::<url::Url>()
        .map_err(|e| format!("{raw} is not a valid URL: {e}"))
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown error".to_string()
        };
        eprintln!("AgentX encountered an error: {message}");
        if let Some(app) = APP_HANDLE.get() {
            show_error(app, "AgentX encountered an error", &message);
        }
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let _ = APP_HANDLE.set(app.handle().clone());

            let url = match web_url() {
                Ok(url) => url,
                Err(message) => {
                    show_error(
                        app.handle(),
                        "AgentX could not start",
                        &format!("The application UI could not be loaded.\n\n{message}"),
                    );
                    std::process::exit(1);
                }
            };

            let app_url = url.clone();
            let handle = app.handle().clone();
            let window = tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("AgentX")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1100.0, 700.0)
                .on_navigation(move |nav_url| {
                    // Mirror Electron's setWindowOpenHandler: links that
                    // leave the app origin open in the system browser and
                    // are never loaded inside the webview.
                    // EXCEPTION: GitHub OAuth stays inside the webview.
                    // Sign-in sets the `agentx_oauth_state` cookie in this
                    // webview and GitHub redirects back to the callback URL
                    // here; handing github.com off to the system browser
                    // loses that cookie, so the callback always fails
                    // with "Invalid OAuth callback state."
                    if nav_url.origin() != app_url.origin()
                        && nav_url.host_str() != Some("github.com")
                    {
                        let _ = handle.opener().open_url(nav_url.as_str(), None::<&str>);
                        return false;
                    }
                    true
                })
                .build();

            if let Err(e) = window {
                show_error(
                    app.handle(),
                    "AgentX could not start",
                    &format!("The application UI could not be loaded.\n\n{e}"),
                );
                std::process::exit(1);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
