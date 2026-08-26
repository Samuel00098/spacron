mod commands;
mod error;
mod lsp;
mod mcp;
mod preview;
pub mod pty;
// Headless remote-workspace server: reuses the PTY core over a WebSocket so the
// desktop app can attach to a workspace running on a remote box. See
// `docs/remote-workspace.md`. Compiled into the lib; only run by the
// `spacron-server` binary, never by the desktop `run()` path.
pub mod remote;
pub mod state;
mod theme;
mod workspace;

use state::AppState;
use std::io;
use std::sync::Arc;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK (Linux) ships a DMABUF-based GPU renderer that is broken on a wide
    // range of drivers (many Intel/AMD/NVIDIA + virtualized GPUs). When it fails it
    // spams "WebKit encountered an internal error … WebLoaderStrategy" and, worse,
    // leaves composited layers unpainted — the dock and floating bar rendering as
    // present-but-invisible. Forcing the non-DMABUF path makes rendering reliable.
    // Set before the webview process spawns, and only when the user hasn't already
    // chosen a value, so it can still be overridden from the environment.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let base_config_dir = dirs::config_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let config_dir = base_config_dir.join("spacron");

    // One-time migration from the previous app name ("Soryq"). All app data —
    // workspaces, themes, backgrounds, app flags, and downloaded models — lives
    // under <config>/spacron; the former name stored it under <config>/soryq. On
    // the first launch after the rename, relocate the old data so it carries over.
    // Best-effort and non-destructive to any data the renamed build already wrote.
    // NOTE: API keys, the GitHub token, and per-project env-vault secrets live in
    // the OS keychain under the old service name and are NOT moved here; those must
    // be re-entered after switching to Spacron.
    migrate_legacy_config_dir(&base_config_dir.join("soryq"), &config_dir);

    std::fs::create_dir_all(&config_dir).expect("failed to create spacron config directory");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(move |app| {
            #[cfg_attr(
                not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
                allow(unused_variables)
            )]
            let Some(window) = app.get_webview_window("main") else {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "main webview window not found",
                )
                .into());
            };
            #[cfg(target_os = "macos")]
            let _ = window_vibrancy::apply_vibrancy(
                &window,
                window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
                None,
                None,
            );



            #[cfg(target_os = "linux")]
            {
                // WebKitGTK ships with media capture disabled and silently
                // refuses any permission request nobody answers, so on Linux
                // getUserMedia failed even after the user accepted the app's
                // own microphone dialog. Turn the media features on and grant
                // WebKit's capture-related requests — the frontend already
                // gates the microphone behind its own consent dialog before
                // the request ever reaches WebKit. MSE/EME are enabled for
                // embedded players (e.g. the YouTube panel), which stream
                // through MediaSource. macOS and Windows configure all of
                // this through their own webview runtimes.
                if let Err(e) = window.with_webview(|webview| {
                    use webkit2gtk::glib::prelude::*;
                    use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};

                    let webview = webview.inner();
                    if let Some(settings) = WebViewExt::settings(&webview) {
                        settings.set_enable_media_stream(true);
                        settings.set_enable_webrtc(true);
                        settings.set_enable_mediasource(true);
                        settings.set_enable_encrypted_media(true);
                        eprintln!("[spacron] WebKit media/webrtc/mse/eme settings applied");
                    } else {
                        eprintln!("[spacron] WARN: could not access WebKit settings to enable MSE/EME/WebRTC");
                    }
                    webview.connect_permission_request(|_, request| {
                        if request.is::<webkit2gtk::UserMediaPermissionRequest>()
                            || request.is::<webkit2gtk::DeviceInfoPermissionRequest>()
                        {
                            request.allow();
                            return true;
                        }
                        // Anything else keeps WebKit's default handling.
                        false
                    });
                }) {
                    eprintln!("[spacron] WARN: failed to configure WebKit media settings: {e}");
                }
            }

            #[cfg(target_os = "windows")]
            {
                // Try acrylic first (frosted glass), fallback to mica or basic blur
                if window_vibrancy::apply_acrylic(&window, Some((15, 15, 20, 10))).is_err() {
                    let _ = window_vibrancy::apply_mica(&window, None);
                }

                // Turn off WebView2's built-in pinch-zoom and swipe-navigation.
                // Otherwise the runtime swallows trackpad pinch to scale the whole
                // view (so the sketch canvas never receives the ctrl+wheel it uses
                // to zoom) and a two-finger horizontal swipe triggers back/forward.
                let _ = window.with_webview(|webview| {
                    use webview2_com::Microsoft::Web::WebView2::Win32::{
                        ICoreWebView2Settings5, ICoreWebView2Settings6,
                    };
                    use windows::core::Interface;
                    unsafe {
                        if let Ok(core) = webview.controller().CoreWebView2() {
                            if let Ok(settings) = core.Settings() {
                                if let Ok(s5) = settings.cast::<ICoreWebView2Settings5>() {
                                    let _ = s5.SetIsPinchZoomEnabled(false.into());
                                }
                                if let Ok(s6) = settings.cast::<ICoreWebView2Settings6>() {
                                    let _ = s6.SetIsSwipeNavigationEnabled(false.into());
                                }
                            }
                        }
                    }
                });
            }

            // ── Start the MCP agent-to-agent communication server ───────────
            let app_state = AppState::new(config_dir.clone());
            let pty_manager = app_state.pty_manager.clone();
            let app_handle = app.handle().clone();
            app.manage(app_state);

            let read_cb: mcp::ReadFn = {
                let pm = pty_manager.clone();
                Arc::new(move |session_id| match pm.get(session_id) {
                    Some(session) => session.read_output(),
                    None => Vec::new(),
                })
            };

            let spawn_fn: mcp::SpawnFn = {
                let ah = app_handle.clone();
                Arc::new(move |req| {
                    // Emit the struct itself rather than re-listing its fields:
                    // a hand-copied list silently drops anything added later,
                    // which is exactly how `name` went missing — the frontend
                    // then generated a random name and `delegate_task` had no
                    // way to address the worker it had just dispatched.
                    let _ = ah.emit("mcp:spawn-agent", &req);
                })
            };

            // Every tool that puts text into an agent goes through here rather
            // than writing to the PTY: the agent CLIs are TUIs, and text only
            // lands if it is pasted into the composer and submitted with Enter
            // once the composer has settled. The frontend owns that sequence
            // (`deliverPromptRaw`), so a raw write is not a shortcut to it — it
            // is a message that sits in the composer and is never sent.
            let deliver_emit_fn: mcp::DeliverEmitFn = {
                let ah = app_handle.clone();
                Arc::new(move |request_id, session_id, message| {
                    let _ = ah.emit(
                        "mcp:deliver-prompt",
                        serde_json::json!({
                            "request_id": request_id,
                            "session_id": session_id,
                            "message": message,
                        }),
                    );
                })
            };

            // An agent reporting on its own turn. The event carries the session
            // the *token* proved, never anything the agent claimed, so the
            // frontend can tell "Iris says she's done" from "an agent on this
            // machine says it's done" — see `report_status` in mcp/mod.rs.
            let report_fn: mcp::ReportFn = {
                let ah = app_handle.clone();
                Arc::new(move |report| {
                    let _ = ah.emit("mcp:agent-report", &report);
                })
            };

            match mcp::start(0, read_cb, spawn_fn, deliver_emit_fn, report_fn) {
                Ok((handle, port)) => {
                    app.manage(mcp::McpServer(Some(handle)));
                    eprintln!("MCP server started on port {}", port);
                }
                Err(e) => {
                    eprintln!("Failed to start MCP server: {}", e);
                    // Manage the empty wrapper anyway: the `mcp_*` commands must
                    // still have state to extract, or the frontend's first call
                    // fails as unmanaged state instead of as "server not
                    // running". See `mcp::McpServer`.
                    app.manage(mcp::McpServer(None));
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::theme::theme_list,
            commands::theme::theme_activate,
            commands::theme::theme_get_active,
            commands::app_flags::app_flag_get,
            commands::app_flags::app_flag_set,
            commands::project_state::project_state_read,
            commands::project_state::project_state_write,
            commands::project_state::project_state_clear,
            commands::audio::check_audio_safe,
            commands::audio::check_gstreamer_codecs,
            commands::background::background_image_set,
            commands::background::background_image_get,
            commands::background::background_image_clear,
            commands::secrets::provider_api_key_exists,
            commands::secrets::provider_api_key_set,
            commands::secrets::provider_api_key_delete,
            commands::secrets::remote_token_set,
            commands::secrets::remote_token_get,
            commands::secrets::remote_token_delete,
            commands::secrets::ai_refine_prompt,
            commands::secrets::ai_transcribe_audio,
            commands::secrets::ai_complete,
            commands::secrets::ai_generate_commit_message,
            commands::secrets::list_provider_models,
            commands::secrets::check_local_provider_online,
            commands::secrets::openai_realtime_connect,
            commands::secrets::xai_realtime_client_secret,
            commands::models::list_downloadable_models,
            commands::models::download_model,
            commands::models::cancel_download,
            commands::models::delete_model,
            commands::models::get_model_path,
            commands::onnx_runtime::onnx_runtime_status,
            commands::onnx_runtime::onnx_runtime_download,
            commands::onnx_runtime::onnx_runtime_remove,
            commands::models::local_stt_transcribe,
            commands::vad::vad_session_start,
            commands::vad::vad_session_feed,
            commands::vad::vad_session_end,
            commands::fs_watch::start_fs_watch,
            commands::fs_watch::stop_fs_watch,
            commands::http::http_send_request,
            commands::remote_relay::remote_relay_start,
            commands::remote_deploy::remote_deploy_vps,
            commands::remote_deploy::remote_detect_platform,
            commands::remote_deploy::remote_server_binary_status,
            commands::remote_deploy::remote_download_server,
            commands::http::fetch_agent_logo,
            commands::music_library::music_library_scan,
            commands::music_library::music_library_reveal,
            commands::notification::notification_show,
            commands::workspace::workspace_open_project,
            commands::workspace::workspace_create_project,
            commands::workspace::workspace_get_active,
            commands::workspace::workspace_set_active,
            commands::workspace::workspace_list_projects,
            commands::workspace::workspace_get_recent,
            commands::workspace::workspace_clear_recent,
            commands::workspace::workspace_get_recent_daily_notes,
            commands::workspace::workspace_git_push,
            commands::workspace::workspace_git_commit,
            commands::workspace::workspace_git_fetch,
            commands::workspace::workspace_git_status,
            commands::workspace::workspace_git_diff,
            commands::workspace::workspace_resolve_conflict,
            commands::workspace::workspace_git_log,
            commands::workspace::workspace_git_discard_file,
            commands::workspace::workspace_git_discard_all,
            commands::workspace::workspace_detect_port,
            commands::workspace::workspace_search_codebase,
            commands::workspace::workspace_git_branches,
            commands::workspace::workspace_git_checkout,
            commands::workspace::workspace_git_branch_create,
            commands::workspace::workspace_git_branch_delete,
            commands::workspace::workspace_git_create_worktree,
            commands::workspace::workspace_git_remove_worktree,
            commands::workspace::workspace_git_list_worktrees,
            commands::workspace::workspace_git_prune_worktrees,
            commands::workspace::workspace_git_sweep_agent_branches,
            commands::workspace::workspace_git_merge_worktree,
            commands::workspace::workspace_git_worktree_has_changes,
            commands::workspace::workspace_git_worktree_status,
            commands::workspace::workspace_git_worktree_delta,
            commands::workspace::workspace_git_stage_worktree,
            commands::workspace::workspace_git_rename_worktree,
            commands::github::github_token_set,
            commands::github::github_token_exists,
            commands::github::github_token_delete,
            commands::github::github_auth_options,
            commands::github::github_oauth_start,
            commands::github::github_oauth_poll,
            commands::github::github_signed_in_user,
            commands::github::github_list_repos,
            commands::github::github_cli_sign_in,
            commands::github::workspace_github_create_repo,
            commands::github::workspace_clone_repo,
            commands::db::db_list_tables,
            commands::db::db_execute_query,
            commands::file_system::fs_read_dir,
            commands::file_system::fs_create_file,
            commands::file_system::fs_create_dir,
            commands::file_system::fs_rename,
            commands::file_system::fs_delete,
            commands::file_system::fs_copy,
            commands::file_system::fs_read_file,
            commands::file_system::fs_read_binary,
            commands::file_system::fs_write_file,
            commands::file_system::fs_write_binary,
            commands::file_system::save_pasted_image,
            commands::file_system::clear_pasted_images,
            commands::file_system::fs_get_file_info,
            commands::search::search_in_project,
            commands::env_vars::env_vault_get,
            commands::env_vars::env_vault_set,
            commands::env_vars::env_vault_import_dotenv,
            commands::terminal::terminal_create,
            commands::terminal::terminal_attach,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::terminal_list,
            commands::terminal::terminal_list_shells,
            commands::terminal::terminal_get_windows_build,
            commands::lsp::lsp_check_server,
            commands::lsp::lsp_start,
            commands::lsp::lsp_install_server,
            commands::agent_probe::agent_probe_rules_file,
            commands::usage::usage_detect_agents,
            commands::usage::usage_fetch_all,
            commands::agent_accounts::usage_list_accounts,
            commands::agent_accounts::usage_select_account,
            commands::agent_accounts::usage_add_account,
            commands::agent_accounts::usage_remove_account,
            commands::agent_accounts::usage_account_env,
            commands::web_session::web_session_list,
            commands::web_session::web_session_connect,
            commands::web_session::web_session_disconnect,
            commands::usage_stats::stats_get_scan_state,
            commands::usage_stats::stats_set_enabled,
            commands::usage_stats::stats_refresh,
            commands::usage_stats::stats_get_snapshot,
            commands::usage_stats::stats_get_overview,
            commands::activity_stats::activity_record_spawn,
            commands::activity_stats::activity_record_turn,
            commands::activity_stats::activity_get_summary,
            commands::activity_stats::activity_reset,
            commands::keep_awake::keep_awake_set,
            commands::keep_awake::keep_awake_status,
            commands::agent_signals::agent_signal_channel_open,
            commands::agent_signals::agent_signal_channel_close,
            commands::workspace::workspace_git_stage_paths,
            commands::workspace::workspace_git_unstage_paths,
            commands::workspace::workspace_git_apply_patch,
            commands::workspace::workspace_git_commit_staged,
            commands::workspace::workspace_git_diff_split,
            commands::workspace::workspace_git_staged_paths,
            commands::workspace::workspace_git_worktree_diff_stat,
            commands::preview::preview_start_proxy,
            commands::preview::preview_start_local_proxy,
            commands::preview::preview_stop_proxy,
            commands::preview::preview_set_target_port,
            commands::preview::preview_set_preferred_local_host,
            commands::preview::preview_get_target_port,
            commands::preview::preview_get_proxy_port,
            commands::preview::preview_clear_proxy_target,
            commands::preview::preview_open_in_browser,
            commands::preview::preview_capture_screenshot,
            commands::preview::preview_clear_browsing_data,
            commands::preview::preview_set_active_origin,
            commands::preview::preview_set_project_root,
            commands::mobile::mobile_platform,
            commands::mobile::android_check,
            commands::mobile::android_list_devices,
            commands::mobile::android_list_avds,
            commands::mobile::android_launch_avd,
            commands::mobile::android_screencap,
            commands::mobile::android_tap,
            commands::mobile::android_swipe,
            commands::mobile::android_key,
            commands::mobile::android_text,
            commands::mobile::android_rotate,
            commands::mobile::android_emu_kill,
            commands::mobile::android_logcat,
            commands::mobile::ios_available,
            commands::mobile::ios_list_simulators,
            commands::mobile::ios_boot,
            commands::mobile::ios_shutdown,
            commands::mobile::ios_open_simulator,
            commands::mobile::ios_screenshot,
            commands::mobile_stream::mobile_stream_start,
            commands::mobile_stream::mobile_stream_stop,
            commands::mobile_stream::mobile_input_touch,
            commands::mobile_stream::mobile_input_key,
            commands::mobile_stream::mobile_input_text,
            commands::ios_sim::ios_sim_stream_start,
            commands::ios_sim::ios_sim_stream_stop,
            commands::ios_sim::ios_sim_tap,
            commands::ios_sim::ios_sim_button,
            commands::ios_sim::ios_sim_type,
            commands::ios_sim::ios_sim_rotate,
            commands::mcp::mcp_register_agent,
            commands::mcp::mcp_unregister_agent,
            commands::mcp::mcp_server_port,
            commands::mcp::mcp_open_agent_channel,
            commands::mcp::mcp_bind_agent_channel,
            commands::mcp::mcp_close_agent_channel,
            commands::mcp::mcp_server_url,
            commands::mcp::mcp_server_http_url,
            commands::mcp::mcp_read_global_agent_config,
            commands::mcp::mcp_write_global_agent_config,
            commands::mcp::mcp_write_launch_config,
            commands::mcp::mcp_set_project_root,
            commands::mcp::mcp_set_agent_presets,
            commands::mcp::mcp_set_assistant_names,
            commands::mcp::mcp_deliver_respond,
        ])
        .build(tauri::generate_context!())
        .expect("error while building forge application")
        .run(|_app, event| {
            // Best-effort: wipe the ephemeral clipboard-pasted-image scratch dir on
            // exit so screenshots pasted this session don't linger on disk.
            if let tauri::RunEvent::Exit = event {
                let _ = commands::file_system::clear_pasted_images();
            }
        });
}

/// Relocate the previous ("Soryq") config directory to the current one on first
/// launch after the rename. Best-effort: it never panics, and it refuses to run
/// if the destination already holds data, so it can never clobber the renamed
/// build's own files.
fn migrate_legacy_config_dir(old_dir: &std::path::Path, new_dir: &std::path::Path) {
    if !old_dir.is_dir() {
        return;
    }

    // Don't touch anything if the new location already has data — only migrate
    // into an absent or empty directory.
    let new_has_data = std::fs::read_dir(new_dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if new_has_data {
        return;
    }

    // Remove an empty placeholder dir so a fast atomic rename can take its place
    // (on Windows `rename` fails if the destination exists).
    if new_dir.exists() {
        let _ = std::fs::remove_dir(new_dir);
    }

    // Prefer an atomic move (instant even for large downloaded models); fall back
    // to a recursive copy if the two paths live on different volumes.
    match std::fs::rename(old_dir, new_dir) {
        Ok(()) => eprintln!("[spacron] migrated data from {old_dir:?} to {new_dir:?}"),
        Err(_) => match copy_dir_recursive(old_dir, new_dir) {
            Ok(()) => eprintln!("[spacron] copied data from {old_dir:?} to {new_dir:?}"),
            Err(err) => eprintln!("[spacron] legacy data migration failed: {err}"),
        },
    }
}

/// Recursively copy `src` into `dst`, creating directories as needed. Symlinks are
/// skipped (app data contains none) to avoid following links outside the tree.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_symlink() {
            continue;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}
