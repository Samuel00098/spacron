use crate::error::ForgeError;
use crate::theme::models::Theme;
use std::fs;
use std::path::PathBuf;

#[allow(dead_code)]
pub fn load_theme_from_file(path: &PathBuf) -> Result<Theme, ForgeError> {
    let content = fs::read_to_string(path)?;
    let theme: Theme = serde_json::from_str(&content)?;
    Ok(theme)
}

pub fn save_theme_to_file(theme: &Theme, path: &PathBuf) -> Result<(), ForgeError> {
    let content = serde_json::to_string_pretty(theme)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

pub fn load_bundled_themes() -> Vec<Theme> {
    let mut themes = Vec::new();

    let dark_theme = Theme {
        id: "forge-dark".to_string(),
        name: "Forge Dark".to_string(),
        theme_type: crate::theme::models::ThemeType::Dark,
        colors: [
            ("bg-primary", "#000000"),
            ("bg-secondary", "#08080a"),
            ("bg-tertiary", "#121215"),
            ("bg-hover", "rgba(255, 255, 255, 0.05)"),
            ("bg-active", "rgba(255, 255, 255, 0.09)"),
            ("text-primary", "#ffffff"),
            ("text-secondary", "#a1a1aa"),
            ("text-muted", "#71717a"),
            // Graphite accent — see the LIGHT_ACCENT/DARK_ACCENT note in
            // src/lib/stores/presetThemes.ts for why the accent is a value,
            // not a hue. Keep these two bundled themes in step with it: they
            // are what ships before the user picks anything, and forge-dark
            // is the default active theme.
            ("accent", "#ffffff"),
            ("accent-hover", "#f4f4f5"),
            // Ink for anything painted with the accent. The dark accent is
            // pure white, so a #000000 label contrasts cleanly.
            ("on-accent", "#000000"),
            ("border", "rgba(255, 255, 255, 0.08)"),
            // Focus is neutral and never the accent.
            ("focus-ring", "rgba(255, 255, 255, 0.45)"),
            ("border-focus", "rgba(255, 255, 255, 0.45)"),
            // Semantic colours, saturated rather than pastel
            ("error", "#ff6b6b"),
            ("warning", "#fbbf24"),
            ("success", "#2ee06d"),
            ("info", "#58a6ff"),
            ("scrollbar-thumb", "rgba(255, 255, 255, 0.10)"),
            ("scrollbar-track", "transparent"),
            ("selection-bg", "rgba(255, 255, 255, 0.18)"),
            ("titlebar-bg", "#08080a"),
            ("titlebar-text", "#ffffff"),
            ("titlebar-border", "rgba(255, 255, 255, 0.05)"),
            ("activitybar-bg", "#08080a"),
            ("activitybar-border", "rgba(255, 255, 255, 0.05)"),
            ("sidebar-bg", "#08080a"),
            ("sidebar-border", "rgba(255, 255, 255, 0.06)"),
            ("editor-bg", "#000000"),
            ("editor-gutter", "#000000"),
            ("statusbar-bg", "#08080a"),
            ("statusbar-border", "rgba(255, 255, 255, 0.05)"),
            ("statusbar-text", "#a1a1aa"),
            ("tab-active-bg", "#000000"),
            ("tab-inactive-bg", "#08080a"),
            ("tab-border", "rgba(255, 255, 255, 0.06)"),
            ("panel-bg", "#000000"),
            ("panel-border", "rgba(255, 255, 255, 0.06)"),
            ("input-bg", "#0d0d10"),
            ("input-border", "rgba(255, 255, 255, 0.12)"),
            ("input-focus-border", "rgba(255, 255, 255, 0.45)"),
            ("button-bg", "#ffffff"),
            ("button-hover-bg", "#f4f4f5"),
            ("button-text", "#000000"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect(),
        syntax: [
            ("keyword", "#c792ea"),
            ("string", "#a5d6ff"),
            ("comment", "#7a7aa8"),
            ("function", "#82aaff"),
            ("number", "#f78c6c"),
            ("type", "#ffcb6b"),
            ("variable", "#f07178"),
            ("operator", "#89ddff"),
            ("punctuation", "#a0a0c0"),
            ("tag", "#ffcb6b"),
            ("attribute", "#82aaff"),
            ("constant", "#ff9cac"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect(),
        background_image: None,
        background_opacity: None,
        background_blur: None,
    };

    let light_theme = Theme {
        id: "forge-light".to_string(),
        name: "Forge Light".to_string(),
        theme_type: crate::theme::models::ThemeType::Light,
        colors: [
            ("bg-primary", "#ffffff"),
            ("bg-secondary", "#f8f9fa"),
            ("bg-tertiary", "#f1f3f5"),
            ("bg-hover", "rgba(0, 0, 0, 0.04)"),
            ("bg-active", "rgba(0, 0, 0, 0.08)"),
            ("text-primary", "#000000"),
            ("text-secondary", "#4b5563"),
            ("text-muted", "#6b7280"),
            ("accent", "#000000"),
            ("accent-hover", "#18181b"),
            ("on-accent", "#ffffff"),
            ("border", "rgba(0, 0, 0, 0.08)"),
            ("focus-ring", "rgba(0, 0, 0, 0.55)"),
            ("border-focus", "rgba(0, 0, 0, 0.55)"),
            ("error", "#d40c0c"),
            ("warning", "#a86008"),
            ("success", "#077f33"),
            ("info", "#1359f3"),
            ("scrollbar-thumb", "rgba(0, 0, 0, 0.12)"),
            ("scrollbar-track", "transparent"),
            ("selection-bg", "rgba(0, 0, 0, 0.10)"),
            ("titlebar-bg", "#ffffff"),
            ("titlebar-text", "#000000"),
            ("titlebar-border", "rgba(0, 0, 0, 0.06)"),
            ("activitybar-bg", "#ffffff"),
            ("activitybar-border", "rgba(0, 0, 0, 0.06)"),
            ("sidebar-bg", "#f8f9fa"),
            ("sidebar-border", "rgba(0, 0, 0, 0.08)"),
            ("editor-bg", "#ffffff"),
            ("editor-gutter", "#ffffff"),
            ("statusbar-bg", "#f8f9fa"),
            ("statusbar-border", "rgba(0, 0, 0, 0.06)"),
            ("statusbar-text", "#4b5563"),
            ("tab-active-bg", "#ffffff"),
            ("tab-inactive-bg", "#f8f9fa"),
            ("tab-border", "rgba(0, 0, 0, 0.08)"),
            ("panel-bg", "#ffffff"),
            ("panel-border", "rgba(0, 0, 0, 0.08)"),
            ("input-bg", "#ffffff"),
            ("input-border", "rgba(0, 0, 0, 0.12)"),
            ("input-focus-border", "rgba(0, 0, 0, 0.55)"),
            ("button-bg", "#000000"),
            ("button-hover-bg", "#18181b"),
            ("button-text", "#ffffff"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect(),
        // Syntax, redrawn from this app's own light palette (the `:root.light-theme`
        // block in global.css) so code reads as colour on a white page. Two
        // things were wrong before, and they are the same two things that made
        // the whole of light mode look flat:
        //
        //   * `string` was #032f62 — 12.7:1, a navy so dark the eye reads it as
        //     body text. A string is the most common coloured token in most
        //     files, so the single largest block of colour on screen wasn't
        //     reading as colour at all.
        //   * `type` / `variable` sat at #e36209, 3.34:1 — under the 4.5:1 code
        //     needs, i.e. bright but not legible, which is the exact trap the
        //     light semantic colours fell into.
        //
        // Every token keeps its hue family (red keywords, green tags, violet
        // functions, orange types — Forge Light's character is unchanged) and
        // every one now clears 4.5:1 on #fafafa. `number`/`constant` move from
        // blue to amber only because blue was covering four tokens at once and
        // the palette had no room left to make `string` a real blue.
        syntax: [
            ("keyword", "#d40c0c"),     // 5.22:1
            ("string", "#1359f3"),      // 5.36:1
            ("comment", "#57606a"),     // 6.12:1
            ("function", "#6d28d9"),    // 6.81:1
            ("number", "#a86008"),      // 4.63:1
            ("type", "#b25708"),        // 4.72:1
            ("variable", "#b25708"),    // 4.72:1
            ("operator", "#d40c0c"),    // 5.22:1
            ("punctuation", "#24292e"), // 14.05:1
            ("tag", "#077f33"),         // 4.92:1
            ("attribute", "#0e7490"),   // 5.13:1
            ("constant", "#a86008"),    // 4.63:1
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect(),
        background_image: None,
        background_opacity: None,
        background_blur: None,
    };

    themes.push(dark_theme);
    themes.push(light_theme);
    themes
}
