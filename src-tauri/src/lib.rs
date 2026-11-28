mod commands;
mod acp;
mod pi;
mod desktop;
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
mod worktree_snapshot;

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

    let builder = tauri::Builder::default();
    // Must be the first plugin. A second launch (Explorer's "Open with Spacron"
    // while the app is open) exits at once and hands its paths to this window,
    // which opens them as projects. Release builds only: `tauri dev` shares the
    // identifier, so a dev window would otherwise swallow the installed app's
    // launches, or the installed app would refuse to start beside it.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        let paths = commands::launch::project_paths_from_args(
            argv.into_iter().skip(1),
            std::path::Path::new(&cwd),
        );
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        if !paths.is_empty() {
            let _ = app.emit("app:open-paths", paths);
        }
    }));

    // Computer use's stop shortcut on macOS and Linux (docs/computer-use.md).
    // Registered only while computer use is on (see `desktop::start_guard`).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|_app, _shortcut, event| {
                if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    desktop::stop_shortcut_pressed();
                }
            })
            .build(),
    );

    builder
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
                // embedded players (e.g. a YouTube page in Preview), which stream
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
            // Bots on this PC, for people without a box yet.
            commands::local_bots::start(&config_dir);
            // Learn every configured provider's model capabilities in the
            // background (and again when a key is saved); see agent_turn/capabilities.rs.
            commands::secrets::agent_turn::start_capability_refresh(app.handle().clone());
            // The chat's Playwright browsers, one per conversation
            // (docs/agent-browser.md). Children are kill_on_drop, so they die with the app.
            app.manage(Arc::new(commands::browser_tools::BrowserSessions::default()));
            app.manage(Arc::new(commands::mcp_client::McpClients::default()));
            commands::images::allow_image_dirs(app.handle(), &config_dir);

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

            // Computer use (docs/computer-use.md). A grant request blocks the
            // agent's tool call until the frontend's dialog answers through
            // `mcp_desktop_grant_respond` (or it times out); the indicator is a
            // native overlay window; notices become toasts.
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let shortcut_ah = app_handle.clone();
                desktop::set_stop_shortcut_registrar(Arc::new(move |on| {
                    let shortcut = "Ctrl+Alt+Escape";
                    if on {
                        shortcut_ah.global_shortcut().register(shortcut).is_ok()
                    } else {
                        shortcut_ah.global_shortcut().unregister(shortcut).is_ok()
                    }
                }));
            }
            let desktop_hooks = {
                let grant_ah = app_handle.clone();
                let notice_ah = app_handle.clone();
                #[cfg(windows)]
                let indicator_ah = app_handle.clone();
                desktop::DesktopHooks {
                    grant: Arc::new(move |request| {
                        let _ = grant_ah.emit("mcp:desktop-grant-request", request);
                    }),
                    #[cfg(windows)]
                    indicator: Arc::new(move |state| desktop::indicator::update(&indicator_ah, state)),
                    #[cfg(not(windows))]
                    indicator: Arc::new(|_| {}),
                    notice: Arc::new(move |message| {
                        let _ = notice_ah.emit("mcp:desktop-notice", message);
                    }),
                }
            };

            match mcp::start(0, read_cb, spawn_fn, deliver_emit_fn, report_fn, desktop_hooks) {
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
            commands::chatgpt::chatgpt_status,
            commands::chatgpt::codex_app_server_launch,
            commands::chatgpt::chatgpt_chat_complete,
            commands::claude::claude_chat_complete,
            commands::claude::claude_fork_session,
            commands::cursor::cursor_chat_complete,
            commands::custom_providers::custom_providers_list,
            commands::muse::muse_chat_complete,
            commands::opencode::opencode_chat_complete,
            commands::custom_providers::custom_provider_save,
            commands::custom_providers::custom_provider_delete,
            commands::custom_providers::custom_provider_icon,
            commands::chatgpt::chatgpt_login_start,
            commands::chatgpt::chatgpt_login_cancel,
            commands::chatgpt::chatgpt_logout,
            commands::agent_updates::agent_updates_check,
            commands::agent_updates::agent_update_install,
            commands::deepseek_harness::deepseek_harness_status,
            commands::deepseek_harness::deepseek_harness_worker_files,
            commands::deepseek_harness::deepseek_harness_write_task,
            commands::deepseek_harness::deepseek_harness_web_open,
            commands::deepseek_harness::deepseek_harness_web_stop,
            commands::secrets::provider_api_key_exists,
            commands::secrets::provider_api_key_set,
            commands::secrets::provider_api_key_delete,
            commands::jev::jev_classify,
            commands::jev::jev_source_supported,
            commands::jev::jev_agent_usage,
            commands::secrets::remote_token_set,
            commands::secrets::remote_token_get,
            commands::secrets::remote_token_delete,
            commands::secrets::ai_refine_prompt,
            commands::secrets::ai_transcribe_audio,
            commands::secrets::ai_complete,
            commands::secrets::agent_turn::ai_agent_turn,
            commands::secrets::agent_turn::ai_agent_cancel,
            commands::secrets::agent_turn::ai_agent_capabilities,
            commands::secrets::agent_turn::ai_models_capabilities,
            commands::secrets::agent_turn::ai_refresh_model_capabilities,
            commands::secrets::agent_turn::ai_agent_probe,
            commands::images::generate_media,
            commands::speech::read_aloud_speak,
            commands::speech::read_aloud_voices,
            commands::speech::read_aloud_openrouter_models,
            commands::speech::read_aloud_provider_models,
            commands::images::allow_generations_dir,
            commands::images::list_generations,
            commands::images::save_edit_mark,
            commands::images::generate_image_cancel,
            commands::images::save_image_copy,
            commands::images::rename_image,
            commands::images::reveal_image,
            commands::images::generated_images_folder,
            commands::secrets::ai_generate_commit_message,
            commands::secrets::list_provider_models,
            commands::secrets::check_local_provider_online,
            commands::secrets::openai_realtime_connect,
            commands::secrets::openai_live_connect,
            commands::secrets::xai_realtime_client_secret,
            commands::secrets::vercel_realtime_client_secret,
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
            commands::remote_tunnel::remote_tunnel_open_mcp,
            commands::remote_tunnel::remote_tunnel_forward,
            commands::remote_tunnel::remote_tunnel_close_all,
            commands::remote_send::project_send_prepare,
            commands::remote_send::project_send_read_chunk,
            commands::remote_send::project_send_cleanup,
            commands::remote_deploy::remote_deploy_vps,
            commands::remote_deploy::remote_detect_platform,
            commands::remote_deploy::remote_server_binary_status,
            commands::remote_deploy::remote_download_server,
            commands::http::fetch_agent_logo,
            commands::notification::notification_show,
            commands::open_with::workspace_open_with_app,
            commands::launch::app_launch_paths,
            commands::workspace::workspace_open_project,
            commands::workspace::workspace_create_project,
            commands::chat_workspace::chat_workspace_open,
            commands::local_bots::local_bots_sync,
            commands::local_bots::local_bots_state,
            commands::local_bots::local_bot_run_now,
            commands::local_bots::local_bot_log,
            commands::local_bots::local_bot_stop,
            commands::local_bots::local_bot_proposals_ack,
            commands::local_bots::local_bot_attach,
            commands::local_bots::local_bot_file,
            commands::local_bots::local_bot_delete,
            commands::remote_tunnel::remote_share_mcp_grants,
            commands::chat_workspace::chat_workspace_reveal,
            commands::chat_workspace::chat_workspace_export,
            commands::workspace::workspace_rename_project,
            commands::workspace::workspace_get_active,
            commands::workspace::workspace_set_active,
            commands::workspace::workspace_list_projects,
            commands::workspace::workspace_get_recent,
            commands::workspace::workspace_clear_recent,
            commands::workspace::workspace_get_recent_daily_notes,
            commands::workspace::workspace_git_push,
            commands::workspace::workspace_git_commit,
            commands::workspace::workspace_git_pull,
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
            commands::thread_pr::workspace_git_commit_and_open_pr,
            commands::workspace::workspace_git_remove_worktree,
            commands::workspace::workspace_git_list_worktrees,
            commands::workspace::workspace_git_prune_worktrees,
            commands::project_worktrees::project_worktree_list,
            commands::project_worktrees::project_worktree_review_metadata,
            commands::project_worktrees::project_worktree_bases,
            commands::project_worktrees::project_worktree_create,
            commands::project_worktrees::project_worktree_delete,
            commands::project_worktrees::project_worktree_update,
            commands::workspace::workspace_git_sweep_agent_branches,
            commands::workspace::workspace_git_merge_worktree,
            commands::workspace::workspace_git_worktree_has_changes,
            commands::workspace::workspace_git_worktree_status,
            commands::workspace::workspace_git_worktree_delta,
            commands::workspace::workspace_git_stage_worktree,
            commands::workspace::workspace_git_snapshot_worktree,
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
            commands::github::source_control_token_set,
            commands::github::source_control_token_exists,
            commands::github::source_control_token_delete,
            commands::github::source_control_signed_in_user,
            commands::github::source_control_auth_options,
            commands::source_control::source_control_repo_info,
            commands::linear::linear_account,
            commands::linear::linear_connect,
            commands::linear::linear_disconnect,
            commands::linear::linear_scopes,
            commands::linear::linear_issues,
            commands::linear::linear_issue,
            commands::source_control::source_control_list_issues,
            commands::source_control::source_control_get_issue_details,
            commands::source_control::source_control_create_issue,
            commands::source_control::source_control_update_issue_state,
            commands::source_control::source_control_add_issue_comment,
            commands::source_control::source_control_list_pull_requests,
            commands::source_control::source_control_create_pull_request,
            commands::source_control::source_control_get_pr_details,
            commands::source_control::source_control_get_pr_files,
            commands::source_control::source_control_get_pr_checks,
            commands::source_control::source_control_merge_pr,
            commands::source_control::source_control_add_pr_comment,
            commands::source_control::source_control_list_workflow_runs,
            commands::source_control::source_control_get_workflow_run_jobs,
            commands::source_control::source_control_get_workflow_job_log,
            commands::source_control::source_control_rerun_workflow,
            commands::source_control::source_control_cancel_workflow_run,
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
            commands::file_system::fs_open_document,
            commands::file_system::fs_allow_media,
            commands::file_system::fs_write_file,
            commands::file_system::save_document_file,
            commands::file_system::fs_write_file_checked,
            commands::file_system::fs_glob_files,
            commands::file_system::fs_write_binary,
            commands::file_system::save_pasted_image,
            commands::file_system::clear_pasted_images,
            commands::file_system::fs_get_file_info,
            commands::search::search_in_project,
            commands::env_vars::env_vault_get,
            commands::env_vars::env_vault_set,
            commands::env_vars::env_vault_import_dotenv,
            commands::terminal::terminal_create,
            commands::acp::acp_start,
            commands::acp::acp_request,
            commands::acp::acp_respond,
            commands::acp::acp_notify,
            commands::acp::acp_close,
            commands::acp::acp_write_raw,
            commands::pi::pi_start,
            commands::pi::pi_command,
            commands::pi::pi_close,
            commands::terminal::terminal_attach,
            commands::terminal::terminal_instance_id,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::browser_shim::browser_shim_path,
            commands::terminal::terminal_close,
            commands::terminal::terminal_list,
            commands::terminal::terminal_list_shells,
            commands::terminal::terminal_get_windows_build,
            commands::lsp::lsp_check_server,
            commands::lsp::lsp_start,
            commands::lsp::lsp_install_server,
            commands::agent_probe::agent_probe_rules_file,
            commands::agent_models::agent_list_models,
            commands::agent_models::agent_cli_generate_commit_message,
            commands::usage::usage_detect_agents,
            commands::usage::usage_fetch_all,
            commands::usage::usage_fetch_accounts,
            commands::agent_accounts::usage_list_accounts,
            commands::agent_accounts::usage_select_account,
            commands::agent_accounts::usage_add_account,
            commands::agent_accounts::usage_remove_account,
            commands::agent_accounts::usage_account_env,
            commands::agent_accounts::usage_set_account_key,
            commands::web_session::web_session_list,
            commands::web_session::web_session_connect,
            commands::web_session::web_session_disconnect,
            commands::antigravity::antigravity_runtime_status,
            commands::antigravity::antigravity_runtime_install,
            commands::agent_binary::agent_binary_status,
            commands::agent_binary::agent_binary_install,
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
            commands::agent_signals::agent_turn_signal_flags,
            commands::about_you::about_you_sync,
            commands::agent_history::agent_history_list,
            commands::agent_history::agent_history_copy_to_account,
            commands::agent_transcript::agent_transcript_read,
            commands::agent_transcript::chat_image_preview,
            commands::agent_transcript::agent_subagent_transcript_read,
            commands::chat_extras::chat_list_files,
            commands::chat_extras::chat_find_file,
            commands::chat_extras::chat_list_skills,
            commands::chat_extras::chat_claude_commands,
            commands::chat_extras::system_font_families,
            commands::chat_extras::chat_link_preview,
            commands::chat_extras::chat_pr_status,
            commands::chat_visuals::chat_visuals_prepare,
            commands::chat_visuals::chat_visuals_write,
            commands::workspace::workspace_git_stage_paths,
            commands::workspace::workspace_git_unstage_paths,
            commands::workspace::workspace_git_apply_patch,
            commands::workspace::workspace_git_commit_staged,
            commands::workspace::workspace_git_diff_split,
            commands::workspace::workspace_git_staged_paths,
            commands::workspace::workspace_git_worktree_diff_stat,
            commands::workspace::project_inspect_any,
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
            commands::mobile::android_avd_details,
            commands::mobile::android_launch_avd,
            commands::mobile::android_boot_ready,
            commands::mobile::android_screencap,
            commands::mobile::android_tap,
            commands::mobile::android_swipe,
            commands::mobile::android_key,
            commands::mobile::android_text,
            commands::mobile::android_rotate,
            commands::mobile::android_preview_resolution,
            commands::mobile::android_fold,
            commands::mobile::android_display_state,
            commands::mobile::android_emu_kill,
            commands::mobile::android_logcat,
            commands::mobile::ios_available,
            commands::mobile::ios_list_simulators,
            commands::mobile::ios_boot,
            commands::mobile::ios_shutdown,
            commands::mobile::ios_open_simulator,
            commands::mobile::ios_screenshot,
            commands::device_tools::device_tools_state,
            commands::device_tools::device_app_action,
            commands::device_tools::device_open_url,
            commands::device_tools::device_set_appearance,
            commands::device_tools::device_set_text_size,
            commands::device_tools::device_set_reduce_motion,
            commands::device_tools::device_set_network,
            commands::device_tools::device_set_layout_bounds,
            commands::device_tools::device_set_location,
            commands::device_tools::device_set_permission,
            commands::device_tools::device_save_screenshot,
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
            commands::ios_sim::ios_sim_fold,
            commands::mcp::mcp_register_agent,
            commands::mcp::mcp_unregister_agent,
            commands::mcp::mcp_set_agent_status,
            commands::mcp::mcp_server_port,
            commands::mcp::mcp_open_agent_channel,
            commands::mcp::mcp_bind_agent_channel,
            commands::mcp::mcp_close_agent_channel,
            commands::mcp::mcp_server_url,
            commands::mcp::mcp_server_http_url,
            commands::mcp::mcp_read_global_agent_config,
            commands::mcp::mcp_write_global_agent_config,
            commands::mcp::agent_workspace_trust,
            commands::mcp::mcp_write_launch_config,
            commands::mcp::mcp_set_project_root,
            commands::mcp::mcp_call_emulator_tool,
            commands::mcp::mcp_set_agent_presets,
            commands::mcp::mcp_set_assistant_names,
            commands::mcp::mcp_set_media_settings,
            commands::mcp_oauth::mcp_oauth_sign_in,
            commands::mcp_oauth::mcp_oauth_cancel,
            commands::mcp_oauth::mcp_oauth_needs_sign_in,
            commands::mcp_oauth::mcp_oauth_status,
            commands::mcp_oauth::mcp_oauth_sign_out,
            commands::deepseek_harness::deepseek_harness_set_user_mcp,
            commands::plugins::plugin_marketplace_fetch,
            commands::plugins::plugin_install_from_marketplace,
            commands::plugins::plugin_install_archive,
            commands::plugins::plugin_read_folder,
            commands::plugins::plugin_create,
            commands::plugins::plugin_write_builtin,
            commands::plugins::plugin_delete_files,
            commands::plugins::plugin_enable_skills,
            commands::plugins::plugin_disable_skills,
            commands::plugins::plugin_listing_icon,
            commands::mcp::mcp_deliver_respond,
            commands::mcp::mcp_computer_use_supported,
            commands::mcp::mcp_set_computer_use,
            commands::mcp::mcp_set_jev_tool,
            commands::mcp::mcp_desktop_grant_respond,
            commands::mcp::mcp_call_desktop_tool,
            commands::mcp::mcp_desktop_end_chat_turn,
            commands::mcp::mcp_desktop_grants,
            commands::mcp::mcp_desktop_revoke,
            commands::mcp::mcp_desktop_activity,
            commands::mcp::mcp_desktop_set_blocked_apps,
            commands::browser_tools::browser_tools_status,
            commands::browser_tools::browser_tools_install,
            commands::browser_tools::browser_tools_check,
            commands::browser_tools::browser_call_tool,
            commands::browser_tools::browser_close_session,
            commands::mcp_client::mcp_client_list_tools,
            commands::mcp_client::mcp_client_call_tool,
            commands::mcp_client::mcp_client_close,
            commands::browser_tools::browser_sign_in_state,
            commands::browser_tools::browser_forget_sign_in,
            commands::browser_tools::browser_sign_in,
        ])
        .build(tauri::generate_context!())
        .expect("error while building forge application")
        .run(|_app, event| {
            // Best-effort: wipe the ephemeral clipboard-pasted-image scratch dir on
            // exit so screenshots pasted this session don't linger on disk.
            if let tauri::RunEvent::Exit = event {
                let _ = commands::file_system::clear_pasted_images();
                // No `dsh web` server may outlive the app.
                commands::deepseek_harness::shutdown_all();
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
