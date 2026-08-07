use crate::error::ForgeError;
use crate::theme::loader::{load_bundled_themes, load_theme_from_file, save_theme_to_file};
use crate::theme::models::{Theme, ThemeInfo, ThemeType};
use std::collections::HashMap;
use std::path::Path;
use std::sync::RwLock;

/// Bumped whenever the bundled brand defaults change and on-disk custom themes
/// derived from an older default should be migrated forward.
/// v1 = amber → teal/sky. v2 = teal/sky → graphite grey. v3 = grey → indigo.
/// v4 = indigo → graphite (the accent stops being a hue; see the note above
/// LIGHT_ACCENT in src/lib/stores/presetThemes.ts).
/// v5 = pastel/washed semantic + syntax colours → saturated ones that clear
/// 4.5:1 in their own mode. Unlike v1–v4 this is not an accent change, so it is
/// the first migration that also rewrites `syntax`.
const BRAND_MIGRATION_VERSION: u32 = 5;

/// Normalize a CSS color for comparison: drop all whitespace, lowercase.
/// Lets `rgba(245, 158, 11, 0.2)` match a stored `rgba(245,158,11,0.2)`.
fn norm_color(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Per-theme-type `(key, old_default, new_default)` map for the amber → teal/sky
/// brand migration. Key-aware so we only rewrite a value that is *still* the exact
/// previous bundled default for that key — any user customization is left intact.
/// `warning` (#fbbf24 / #9a6700) is intentionally absent: it stays amber (semantic).
fn legacy_amber_map(theme_type: &ThemeType) -> &'static [(&'static str, &'static str, &'static str)]
{
    match theme_type {
        ThemeType::Dark => &[
            ("accent", "#f59e0b", "#2dd4bf"),
            ("accent-hover", "#d97706", "#14b8a6"),
            ("border-focus", "#f59e0b", "#2dd4bf"),
            ("input-focus-border", "#f59e0b", "#2dd4bf"),
            ("button-bg", "#b45309", "#0f766e"),
            ("button-hover-bg", "#d97706", "#0d9488"),
            ("selection-bg", "rgba(245,158,11,0.2)", "rgba(45, 212, 191, 0.2)"),
        ],
        ThemeType::Light => &[
            ("accent", "#d97706", "#0d9488"),
            ("accent-hover", "#b45309", "#0f766e"),
            ("border-focus", "#d97706", "#0d9488"),
            ("input-focus-border", "#d97706", "#0d9488"),
            ("button-bg", "#b45309", "#0f766e"),
            ("button-hover-bg", "#92400e", "#115e59"),
            ("selection-bg", "rgba(217,119,6,0.22)", "rgba(13, 148, 136, 0.22)"),
        ],
    }
}

/// Rewrite legacy amber defaults to the teal/sky brand in-place. Returns whether
/// anything changed.
fn migrate_theme_amber(theme: &mut Theme) -> bool {
    apply_color_map(theme, legacy_amber_map(&theme.theme_type))
}

/// Per-theme-type `(key, old_default, new_default)` map for the teal/sky → graphite
/// grey brand migration. Same key-aware contract as `legacy_amber_map`. `warning`
/// stays amber and code syntax colors are untouched (semantic, not brand accent).
fn legacy_teal_map(theme_type: &ThemeType) -> &'static [(&'static str, &'static str, &'static str)] {
    match theme_type {
        ThemeType::Dark => &[
            ("accent", "#2dd4bf", "#aeb6c2"),
            ("accent-hover", "#14b8a6", "#c7cdd6"),
            ("border-focus", "#2dd4bf", "#aeb6c2"),
            ("input-focus-border", "#2dd4bf", "#aeb6c2"),
            ("button-bg", "#0f766e", "#3f4650"),
            ("button-hover-bg", "#0d9488", "#4b525d"),
            ("selection-bg", "rgba(45,212,191,0.2)", "rgba(174, 182, 194, 0.2)"),
        ],
        ThemeType::Light => &[
            ("accent", "#0d9488", "#5b6470"),
            ("accent-hover", "#0f766e", "#474e58"),
            ("border-focus", "#0d9488", "#5b6470"),
            ("input-focus-border", "#0d9488", "#5b6470"),
            ("button-bg", "#0f766e", "#3f4650"),
            ("button-hover-bg", "#115e59", "#2f343b"),
            ("selection-bg", "rgba(13,148,136,0.22)", "rgba(91, 100, 112, 0.22)"),
        ],
    }
}

/// Rewrite legacy teal/sky defaults to the graphite grey brand in-place. Returns
/// whether anything changed.
fn migrate_theme_teal(theme: &mut Theme) -> bool {
    apply_color_map(theme, legacy_teal_map(&theme.theme_type))
}

/// Per-theme-type `(key, old_default, new_default)` map for the graphite grey →
/// indigo brand migration. Same key-aware contract as the maps above.
///
/// This is the migration that brings the bundled themes onto the same two
/// accents as the wallpaper presets: one deep indigo for light, one lifted
/// indigo for dark. Both modes share `button-bg`, because the lifted dark accent
/// is too pale to carry white label text.
fn legacy_grey_map(theme_type: &ThemeType) -> &'static [(&'static str, &'static str, &'static str)] {
    match theme_type {
        ThemeType::Dark => &[
            ("accent", "#aeb6c2", "#818cf8"),
            ("accent-hover", "#c7cdd6", "#a5b4fc"),
            ("border-focus", "#aeb6c2", "#818cf8"),
            ("input-focus-border", "#aeb6c2", "#818cf8"),
            ("button-bg", "#3f4650", "#4f46e5"),
            ("button-hover-bg", "#4b525d", "#5850ec"),
            (
                "selection-bg",
                "rgba(174,182,194,0.2)",
                "rgba(129, 140, 248, 0.22)",
            ),
        ],
        ThemeType::Light => &[
            ("accent", "#5b6470", "#4f46e5"),
            ("accent-hover", "#474e58", "#4338ca"),
            ("border-focus", "#5b6470", "#4f46e5"),
            ("input-focus-border", "#5b6470", "#4f46e5"),
            ("button-bg", "#3f4650", "#4f46e5"),
            ("button-hover-bg", "#2f343b", "#4338ca"),
            (
                "selection-bg",
                "rgba(91,100,112,0.22)",
                "rgba(79, 70, 229, 0.15)",
            ),
        ],
    }
}

/// Rewrite graphite grey defaults to the indigo brand in-place. Returns whether
/// anything changed.
fn migrate_theme_grey(theme: &mut Theme) -> bool {
    apply_color_map(theme, legacy_grey_map(&theme.theme_type))
}

/// Per-theme-type `(key, old_default, new_default)` map for the indigo → graphite
/// brand migration. Same key-aware contract as the maps above.
///
/// Two things differ from every earlier migration. First, focus rings stop
/// tracking the accent and become neutral translucent values — focus fires on
/// every input and tab, and an accent spent that often points at nothing.
/// Second, dark `button-text` flips from white to ink: the dark accent is now
/// near-white, so a white label on a primary button would be invisible. Light
/// `button-text` is absent because white is still correct there.
///
/// `on-accent` and `focus-ring` are new keys, and this map can only rewrite keys
/// a theme already has. That is deliberate — themes missing them fall through to
/// the `:root` / `:root.light-theme` definitions in global.css, which carry
/// mode-correct values for exactly this case.
fn legacy_indigo_map(
    theme_type: &ThemeType,
) -> &'static [(&'static str, &'static str, &'static str)] {
    match theme_type {
        ThemeType::Dark => &[
            ("accent", "#818cf8", "#f1f5f9"),
            ("accent-hover", "#a5b4fc", "#ffffff"),
            ("border-focus", "#818cf8", "rgba(241, 245, 249, 0.45)"),
            ("input-focus-border", "#818cf8", "rgba(241, 245, 249, 0.45)"),
            ("button-bg", "#4f46e5", "#f1f5f9"),
            ("button-hover-bg", "#5850ec", "#ffffff"),
            ("button-text", "#ffffff", "#18181e"),
            (
                "selection-bg",
                "rgba(129,140,248,0.22)",
                "rgba(241, 245, 249, 0.16)",
            ),
        ],
        ThemeType::Light => &[
            ("accent", "#4f46e5", "#1f2328"),
            ("accent-hover", "#4338ca", "#0d1117"),
            ("border-focus", "#4f46e5", "rgba(31, 35, 40, 0.55)"),
            ("input-focus-border", "#4f46e5", "rgba(31, 35, 40, 0.55)"),
            ("button-bg", "#4f46e5", "#1f2328"),
            ("button-hover-bg", "#4338ca", "#0d1117"),
            (
                "selection-bg",
                "rgba(79,70,229,0.15)",
                "rgba(31, 35, 40, 0.12)",
            ),
        ],
    }
}

/// Rewrite indigo defaults to the graphite brand in-place. Returns whether
/// anything changed.
fn migrate_theme_indigo(theme: &mut Theme) -> bool {
    apply_color_map(theme, legacy_indigo_map(&theme.theme_type))
}

/// Per-theme-type `(key, old_default, new_default)` map for the washed → vivid
/// pass on semantic colours. Same key-aware contract as the maps above.
///
/// This one is not about the brand accent at all. The dark defaults were
/// pastel and the light ones were pitched for a dark page, so several sat
/// under the 4.5:1 that body-sized text needs — bright, but not legible, which
/// is what read as "washed out". `info` is absent from both lists because
/// neither bundled theme ever declared it; a theme without the key falls
/// through to global.css, which already carries a mode-correct value.
fn legacy_washed_map(
    theme_type: &ThemeType,
) -> &'static [(&'static str, &'static str, &'static str)] {
    match theme_type {
        ThemeType::Dark => &[
            ("error", "#f87171", "#ff6b6b"),
            ("success", "#4ade80", "#2ee06d"),
        ],
        ThemeType::Light => &[
            ("error", "#cf222e", "#d40c0c"),
            ("warning", "#9a6700", "#a86008"),
            ("success", "#1a7f37", "#077f33"),
        ],
    }
}

/// Per-theme-type `(token, old_default, new_default)` map for the same pass over
/// `syntax`.
///
/// Dark syntax was already vivid apart from the comment, which measured 2.15:1.
/// Light syntax needed the real work: `string` was a navy dark enough to read as
/// body text, `type`/`variable` failed contrast outright, and blue was spread
/// over four tokens at once, which is why `number`/`constant`/`attribute` all
/// share an old value here and land on three different new ones.
fn legacy_washed_syntax_map(
    theme_type: &ThemeType,
) -> &'static [(&'static str, &'static str, &'static str)] {
    match theme_type {
        ThemeType::Dark => &[("comment", "#4a4a7a", "#7a7aa8")],
        ThemeType::Light => &[
            ("keyword", "#d73a49", "#d40c0c"),
            ("operator", "#d73a49", "#d40c0c"),
            ("string", "#032f62", "#1359f3"),
            ("function", "#6f42c1", "#6d28d9"),
            ("number", "#005cc5", "#a86008"),
            ("constant", "#005cc5", "#a86008"),
            ("attribute", "#005cc5", "#0e7490"),
            ("type", "#e36209", "#b25708"),
            ("variable", "#e36209", "#b25708"),
            ("tag", "#22863a", "#077f33"),
        ],
    }
}

/// Rewrite washed-out semantic and syntax defaults to the vivid set in-place.
/// Returns whether anything changed.
fn migrate_theme_washed(theme: &mut Theme) -> bool {
    let colors_changed = apply_color_map(theme, legacy_washed_map(&theme.theme_type));
    let syntax_changed = apply_syntax_map(theme, legacy_washed_syntax_map(&theme.theme_type));
    colors_changed || syntax_changed
}

/// Apply a key-aware `(key, old, new)` color map to a theme, rewriting only values
/// that still exactly match the previous bundled default. Returns whether anything
/// changed.
fn apply_color_map(
    theme: &mut Theme,
    map: &[(&str, &str, &str)],
) -> bool {
    let mut changed = false;
    for (key, old, new) in map {
        if let Some(value) = theme.colors.get_mut(*key) {
            if norm_color(value) == norm_color(old) {
                *value = (*new).to_string();
                changed = true;
            }
        }
    }
    changed
}

/// `apply_color_map` for the `syntax` map. Same key-aware, only-if-unmodified
/// contract: a token the user has repainted keeps their value.
fn apply_syntax_map(theme: &mut Theme, map: &[(&str, &str, &str)]) -> bool {
    let mut changed = false;
    for (key, old, new) in map {
        if let Some(value) = theme.syntax.get_mut(*key) {
            if norm_color(value) == norm_color(old) {
                *value = (*new).to_string();
                changed = true;
            }
        }
    }
    changed
}

/// One-shot migration of on-disk custom themes from the old amber brand to teal/sky.
/// Gated by a version marker so it runs at most once per bump; failures are
/// best-effort and never block startup.
fn run_brand_migration(config_dir: &Path) {
    let marker = config_dir.join(".theme_brand_migration");
    let current: u32 = std::fs::read_to_string(&marker)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    if current >= BRAND_MIGRATION_VERSION {
        return;
    }

    let themes_dir = config_dir.join("themes");
    if themes_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&themes_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("json") {
                    if let Ok(mut theme) = load_theme_from_file(&path) {
                        // Chain migrations so a theme still on the original amber
                        // brand is carried amber → teal → grey → indigo → graphite
                        // in one pass. The washed pass is independent of the accent
                        // chain — it touches semantic and syntax colours only — so
                        // it runs last and applies whatever the accent history was.
                        let amber_changed = migrate_theme_amber(&mut theme);
                        let teal_changed = migrate_theme_teal(&mut theme);
                        let grey_changed = migrate_theme_grey(&mut theme);
                        let indigo_changed = migrate_theme_indigo(&mut theme);
                        let washed_changed = migrate_theme_washed(&mut theme);
                        if amber_changed
                            || teal_changed
                            || grey_changed
                            || indigo_changed
                            || washed_changed
                        {
                            let _ = save_theme_to_file(&theme, &path);
                        }
                    }
                }
            }
        }
    }

    let _ = std::fs::create_dir_all(config_dir);
    let _ = std::fs::write(&marker, BRAND_MIGRATION_VERSION.to_string());
}

pub struct ThemeRegistry {
    config_dir: std::path::PathBuf,
    themes: RwLock<HashMap<String, Theme>>,
    active_theme: RwLock<String>,
}

impl ThemeRegistry {
    pub fn new(config_dir: std::path::PathBuf) -> Self {
        // One-time brand migration of on-disk custom themes (amber → teal/sky),
        // run before they're read below so the migrated values are what load.
        run_brand_migration(&config_dir);

        let mut theme_map = HashMap::new();
        for theme in load_bundled_themes() {
            theme_map.insert(theme.id.clone(), theme);
        }

        // Load custom themes
        let custom_themes_dir = config_dir.join("themes");
        if custom_themes_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&custom_themes_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("json") {
                        if let Ok(theme) = crate::theme::loader::load_theme_from_file(&path) {
                            theme_map.insert(theme.id.clone(), theme);
                        }
                    }
                }
            }
        }

        // Load active theme setting
        let active_theme_file = config_dir.join("active_theme.txt");
        let active_theme = if active_theme_file.exists() {
            std::fs::read_to_string(&active_theme_file)
                .unwrap_or_else(|_| "forge-dark".to_string())
                .trim()
                .to_string()
        } else {
            "forge-dark".to_string()
        };

        ThemeRegistry {
            config_dir,
            themes: RwLock::new(theme_map),
            active_theme: RwLock::new(active_theme),
        }
    }

    pub fn list_themes(&self) -> Result<Vec<ThemeInfo>, ForgeError> {
        let themes = self
            .themes
            .read()
            .map_err(|_| ForgeError::Io(std::io::Error::other("Lock poisoned")))?;
        Ok(themes.values().map(ThemeInfo::from).collect())
    }

    pub fn get_active_theme(&self) -> Result<Theme, ForgeError> {
        let active_id = self
            .active_theme
            .read()
            .map_err(|_| ForgeError::Io(std::io::Error::other("Lock poisoned")))?;
        let themes = self
            .themes
            .read()
            .map_err(|_| ForgeError::Io(std::io::Error::other("Lock poisoned")))?;
        themes
            .get(&*active_id)
            .cloned()
            .ok_or_else(|| ForgeError::ThemeNotFound(active_id.clone()))
    }

    pub fn activate_theme(&self, theme_id: &str) -> Result<Theme, ForgeError> {
        let themes = self
            .themes
            .read()
            .map_err(|_| ForgeError::Io(std::io::Error::other("Lock poisoned")))?;
        if !themes.contains_key(theme_id) {
            return Err(ForgeError::ThemeNotFound(theme_id.to_string()));
        }
        drop(themes);

        let mut active = self
            .active_theme
            .write()
            .map_err(|_| ForgeError::Io(std::io::Error::other("Lock poisoned")))?;
        *active = theme_id.to_string();

        let active_theme_file = self.config_dir.join("active_theme.txt");
        let _ = std::fs::write(active_theme_file, theme_id);
        drop(active);

        let themes = self
            .themes
            .read()
            .map_err(|_| ForgeError::Io(std::io::Error::other("Lock poisoned")))?;
        themes
            .get(theme_id)
            .cloned()
            .ok_or_else(|| ForgeError::ThemeNotFound(theme_id.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme_with(theme_type: ThemeType, colors: &[(&str, &str)]) -> Theme {
        Theme {
            id: "t".into(),
            name: "T".into(),
            theme_type,
            colors: colors
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            syntax: HashMap::new(),
            background_image: None,
            background_opacity: None,
            background_blur: None,
        }
    }

    #[test]
    fn migrates_dark_amber_defaults_to_teal() {
        let mut t = theme_with(
            ThemeType::Dark,
            &[
                ("accent", "#f59e0b"),
                ("border-focus", "#f59e0b"),
                ("selection-bg", "rgba(245, 158, 11, 0.2)"),
                ("warning", "#fbbf24"),
            ],
        );
        assert!(migrate_theme_amber(&mut t));
        assert_eq!(t.colors["accent"], "#2dd4bf");
        assert_eq!(t.colors["border-focus"], "#2dd4bf");
        assert_eq!(t.colors["selection-bg"], "rgba(45, 212, 191, 0.2)");
        // warning is semantic — must stay amber.
        assert_eq!(t.colors["warning"], "#fbbf24");
    }

    #[test]
    fn key_aware_disambiguates_shared_old_hex() {
        // In the old dark theme #d97706 was BOTH accent-hover and button-hover-bg,
        // but they migrate to different new colors — the map must key off the field.
        let mut t = theme_with(
            ThemeType::Dark,
            &[("accent-hover", "#d97706"), ("button-hover-bg", "#d97706")],
        );
        assert!(migrate_theme_amber(&mut t));
        assert_eq!(t.colors["accent-hover"], "#14b8a6");
        assert_eq!(t.colors["button-hover-bg"], "#0d9488");
    }

    #[test]
    fn migrates_light_amber_defaults() {
        let mut t = theme_with(
            ThemeType::Light,
            &[("accent", "#d97706"), ("selection-bg", "rgba(217,119,6,0.22)")],
        );
        assert!(migrate_theme_amber(&mut t));
        assert_eq!(t.colors["accent"], "#0d9488");
        assert_eq!(t.colors["selection-bg"], "rgba(13, 148, 136, 0.22)");
    }

    #[test]
    fn leaves_user_customizations_untouched() {
        // A deliberately-customized accent (not the old default) must not change.
        let mut t = theme_with(ThemeType::Dark, &[("accent", "#ff0066")]);
        assert!(!migrate_theme_amber(&mut t));
        assert!(!migrate_theme_teal(&mut t));
        assert_eq!(t.colors["accent"], "#ff0066");
    }

    #[test]
    fn migrates_dark_teal_defaults_to_grey() {
        let mut t = theme_with(
            ThemeType::Dark,
            &[
                ("accent", "#2dd4bf"),
                ("border-focus", "#2dd4bf"),
                ("button-bg", "#0f766e"),
                ("selection-bg", "rgba(45, 212, 191, 0.2)"),
                ("warning", "#fbbf24"),
            ],
        );
        assert!(migrate_theme_teal(&mut t));
        assert_eq!(t.colors["accent"], "#aeb6c2");
        assert_eq!(t.colors["border-focus"], "#aeb6c2");
        assert_eq!(t.colors["button-bg"], "#3f4650");
        assert_eq!(t.colors["selection-bg"], "rgba(174, 182, 194, 0.2)");
        // warning is semantic — must stay amber.
        assert_eq!(t.colors["warning"], "#fbbf24");
    }

    #[test]
    fn migrates_light_teal_defaults_to_grey() {
        // In the old light theme #0f766e was BOTH accent-hover and button-bg, but
        // they migrate to different greys — the map must key off the field.
        let mut t = theme_with(
            ThemeType::Light,
            &[("accent-hover", "#0f766e"), ("button-bg", "#0f766e")],
        );
        assert!(migrate_theme_teal(&mut t));
        assert_eq!(t.colors["accent-hover"], "#474e58");
        assert_eq!(t.colors["button-bg"], "#3f4650");
    }

    #[test]
    fn chains_amber_through_teal_to_grey() {
        // An untouched original amber theme should end up grey after both passes.
        let mut t = theme_with(ThemeType::Dark, &[("accent", "#f59e0b")]);
        assert!(migrate_theme_amber(&mut t)); // amber → teal
        assert!(migrate_theme_teal(&mut t)); // teal → grey
        assert_eq!(t.colors["accent"], "#aeb6c2");
    }

    #[test]
    fn migrates_dark_grey_defaults_to_indigo() {
        let mut t = theme_with(
            ThemeType::Dark,
            &[
                ("accent", "#aeb6c2"),
                ("border-focus", "#aeb6c2"),
                ("button-bg", "#3f4650"),
                ("selection-bg", "rgba(174, 182, 194, 0.2)"),
                ("warning", "#fbbf24"),
            ],
        );
        assert!(migrate_theme_grey(&mut t));
        assert_eq!(t.colors["accent"], "#818cf8");
        assert_eq!(t.colors["border-focus"], "#818cf8");
        assert_eq!(t.colors["button-bg"], "#4f46e5");
        assert_eq!(t.colors["selection-bg"], "rgba(129, 140, 248, 0.22)");
        // warning is semantic — must stay amber.
        assert_eq!(t.colors["warning"], "#fbbf24");
    }

    #[test]
    fn migrates_light_grey_defaults_to_indigo() {
        // #3f4650 was button-bg in BOTH bundled themes but the light theme's
        // accent (#5b6470) is its own value — the map must key off the field.
        let mut t = theme_with(
            ThemeType::Light,
            &[
                ("accent", "#5b6470"),
                ("accent-hover", "#474e58"),
                ("button-bg", "#3f4650"),
                ("button-hover-bg", "#2f343b"),
            ],
        );
        assert!(migrate_theme_grey(&mut t));
        assert_eq!(t.colors["accent"], "#4f46e5");
        assert_eq!(t.colors["accent-hover"], "#4338ca");
        assert_eq!(t.colors["button-bg"], "#4f46e5");
        assert_eq!(t.colors["button-hover-bg"], "#4338ca");
    }

    #[test]
    fn chains_all_the_way_from_amber_to_indigo() {
        // A theme never opened since the original amber build lands on indigo
        // after one migration pass.
        let mut t = theme_with(ThemeType::Dark, &[("accent", "#f59e0b")]);
        assert!(migrate_theme_amber(&mut t)); // amber → teal
        assert!(migrate_theme_teal(&mut t)); // teal → grey
        assert!(migrate_theme_grey(&mut t)); // grey → indigo
        assert_eq!(t.colors["accent"], "#818cf8");
    }

    #[test]
    fn indigo_migration_leaves_user_customizations_untouched() {
        let mut t = theme_with(ThemeType::Dark, &[("accent", "#ff0066")]);
        assert!(!migrate_theme_grey(&mut t));
        assert_eq!(t.colors["accent"], "#ff0066");
    }

    fn theme_with_syntax(
        theme_type: ThemeType,
        colors: &[(&str, &str)],
        syntax: &[(&str, &str)],
    ) -> Theme {
        let mut t = theme_with(theme_type, colors);
        t.syntax = syntax
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        t
    }

    #[test]
    fn migrates_dark_washed_defaults() {
        let mut t = theme_with_syntax(
            ThemeType::Dark,
            &[
                ("error", "#f87171"),
                ("success", "#4ade80"),
                ("warning", "#fbbf24"),
            ],
            &[("comment", "#4a4a7a"), ("keyword", "#c792ea")],
        );
        assert!(migrate_theme_washed(&mut t));
        assert_eq!(t.colors["error"], "#ff6b6b");
        assert_eq!(t.colors["success"], "#2ee06d");
        // Dark amber was already saturated enough — it is not in the map.
        assert_eq!(t.colors["warning"], "#fbbf24");
        assert_eq!(t.syntax["comment"], "#7a7aa8");
        // The rest of the dark syntax set already cleared contrast.
        assert_eq!(t.syntax["keyword"], "#c792ea");
    }

    #[test]
    fn migrates_light_washed_defaults() {
        let mut t = theme_with_syntax(
            ThemeType::Light,
            &[
                ("error", "#cf222e"),
                ("warning", "#9a6700"),
                ("success", "#1a7f37"),
            ],
            &[("string", "#032f62"), ("type", "#e36209")],
        );
        assert!(migrate_theme_washed(&mut t));
        assert_eq!(t.colors["error"], "#d40c0c");
        assert_eq!(t.colors["warning"], "#a86008");
        assert_eq!(t.colors["success"], "#077f33");
        assert_eq!(t.syntax["string"], "#1359f3");
        assert_eq!(t.syntax["type"], "#b25708");
    }

    #[test]
    fn washed_syntax_map_is_key_aware() {
        // #005cc5 was number, constant AND attribute in the old light theme, and
        // the three land on different colors — the map must key off the token.
        let mut t = theme_with_syntax(
            ThemeType::Light,
            &[],
            &[
                ("number", "#005cc5"),
                ("constant", "#005cc5"),
                ("attribute", "#005cc5"),
            ],
        );
        assert!(migrate_theme_washed(&mut t));
        assert_eq!(t.syntax["number"], "#a86008");
        assert_eq!(t.syntax["constant"], "#a86008");
        assert_eq!(t.syntax["attribute"], "#0e7490");
    }

    #[test]
    fn washed_migration_leaves_user_customizations_untouched() {
        let mut t = theme_with_syntax(
            ThemeType::Light,
            &[("error", "#ff0066")],
            &[("string", "#00ffcc")],
        );
        assert!(!migrate_theme_washed(&mut t));
        assert_eq!(t.colors["error"], "#ff0066");
        assert_eq!(t.syntax["string"], "#00ffcc");
    }

    #[test]
    fn bundled_themes_ship_the_migrated_values() {
        // The migration and the bundled defaults must not drift apart: a theme
        // carried forward should land exactly where a fresh install starts.
        for theme in load_bundled_themes() {
            match theme.theme_type {
                ThemeType::Dark => {
                    assert_eq!(theme.colors["error"], "#ff6b6b");
                    assert_eq!(theme.colors["success"], "#2ee06d");
                    assert_eq!(theme.colors["info"], "#58a6ff");
                    assert_eq!(theme.syntax["comment"], "#7a7aa8");
                }
                ThemeType::Light => {
                    assert_eq!(theme.colors["error"], "#d40c0c");
                    assert_eq!(theme.colors["warning"], "#a86008");
                    assert_eq!(theme.colors["success"], "#077f33");
                    assert_eq!(theme.colors["info"], "#1359f3");
                    assert_eq!(theme.syntax["string"], "#1359f3");
                    assert_eq!(theme.syntax["type"], "#b25708");
                }
            }
        }
    }
}
