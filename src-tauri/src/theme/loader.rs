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
            ("bg-primary", "#18181e"),
            ("bg-secondary", "#121216"),
            ("bg-tertiary", "#22222a"),
            ("bg-hover", "rgba(255, 255, 255, 0.04)"),
            ("bg-active", "rgba(255, 255, 255, 0.07)"),
            ("text-primary", "#f3f3f6"),
            ("text-secondary", "#9494a6"),
            ("text-muted", "#555566"),
            // Graphite accent — see the LIGHT_ACCENT/DARK_ACCENT note in
            // src/lib/stores/presetThemes.ts for why the accent is a value,
            // not a hue. Keep these two bundled themes in step with it: they
            // are what ships before the user picks anything, and forge-dark
            // is the default active theme.
            ("accent", "#f1f5f9"),
            ("accent-hover", "#ffffff"),
            // Ink for anything painted with the accent. The dark accent is
            // near-white, so a #ffffff label would vanish on it.
            ("on-accent", "#18181e"),
            ("border", "rgba(255, 255, 255, 0.06)"),
            // Focus is neutral and never the accent. 0.45 measures 4.19:1
            // against #18181e; a focus indicator needs 3:1.
            ("focus-ring", "rgba(241, 245, 249, 0.45)"),
            ("border-focus", "rgba(241, 245, 249, 0.45)"),
            // Semantic colours, saturated rather than pastel — these are among
            // the last things in the UI still allowed to be a hue (see the
            // accent note above), so they have to read as colour, not as tinted
            // grey. Values match the `:root` set in global.css and must stay in
            // step with it: a theme's own colours are written inline and beat
            // that block, so anything stale here silently wins. `info` was
            // missing entirely, which left it falling through to global.css —
            // the one semantic colour in this theme that was already current.
            // All four clear 6:1 on #18181e.
            ("error", "#ff6b6b"),
            ("warning", "#fbbf24"),
            ("success", "#2ee06d"),
            ("info", "#58a6ff"),
            ("scrollbar-thumb", "rgba(255, 255, 255, 0.08)"),
            ("scrollbar-track", "transparent"),
            ("selection-bg", "rgba(241, 245, 249, 0.16)"),
            ("titlebar-bg", "#121216"),
            ("titlebar-text", "#e2e2eb"),
            ("titlebar-border", "rgba(255, 255, 255, 0.04)"),
            ("activitybar-bg", "#121216"),
            ("activitybar-border", "rgba(255, 255, 255, 0.04)"),
            ("sidebar-bg", "#121216"),
            ("sidebar-border", "rgba(255, 255, 255, 0.05)"),
            ("editor-bg", "#18181e"),
            ("editor-gutter", "#18181e"),
            ("statusbar-bg", "#121216"),
            ("statusbar-border", "rgba(255, 255, 255, 0.04)"),
            ("statusbar-text", "#6060a0"),
            ("tab-active-bg", "#18181e"),
            ("tab-inactive-bg", "#121216"),
            ("tab-border", "rgba(255, 255, 255, 0.05)"),
            ("panel-bg", "#18181e"),
            ("panel-border", "rgba(255, 255, 255, 0.05)"),
            ("input-bg", "#1e1e24"),
            ("input-border", "rgba(255, 255, 255, 0.08)"),
            ("input-focus-border", "rgba(241, 245, 249, 0.45)"),
            ("button-bg", "#f1f5f9"),
            ("button-hover-bg", "#ffffff"),
            ("button-text", "#18181e"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect(),
        syntax: [
            ("keyword", "#c792ea"),
            ("string", "#a5d6ff"),
            // Lifted from #4a4a7a, which measured 2.15:1 on #18181e — a comment
            // should recede, but that was dim enough to disappear. 4.4:1 is the
            // level the wallpaper presets' comments sit at; the indigo cast is
            // unchanged. Every other token here already reads 6:1–11.8:1.
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
            ("bg-primary", "#fafafa"),
            ("bg-secondary", "#f4f4f4"),
            ("bg-tertiary", "#eaeaea"),
            ("bg-hover", "rgba(0, 0, 0, 0.04)"),
            ("bg-active", "rgba(0, 0, 0, 0.08)"),
            ("text-primary", "#1f2328"),
            ("text-secondary", "#444d56"),
            ("text-muted", "#57606a"),
            // Graphite accent, inverted for a bright page: the fill is the
            // far end of this theme's own value range and the label is the
            // near end. #1f2328 is forge-light's text colour, so the accent
            // is literally "the darkest thing on the page".
            ("accent", "#1f2328"),
            ("accent-hover", "#0d1117"),
            ("on-accent", "#ffffff"),
            ("border", "rgba(0, 0, 0, 0.08)"),
            // 0.55 measures 3.59:1 against #fafafa. 0.45 was only 2.74:1 and
            // would fail the 3:1 a focus indicator needs — light pages need
            // the heavier alpha that dark ones don't.
            ("focus-ring", "rgba(31, 35, 40, 0.55)"),
            ("border-focus", "rgba(31, 35, 40, 0.55)"),
            // Semantic colours, deeper than the dark set: the same hue that
            // reads vivid on near-black turns pale on a white page. Values
            // match the `:root.light-theme` block in global.css, which declares
            // them `!important` and therefore already wins over whatever sits
            // here — but the theme editor and any custom theme forked from this
            // one read these, so leaving the old GitHub values behind is drift
            // waiting to surface. All four clear 4.5:1 on #fafafa.
            ("error", "#d40c0c"),
            ("warning", "#a86008"),
            ("success", "#077f33"),
            ("info", "#1359f3"),
            ("scrollbar-thumb", "rgba(0, 0, 0, 0.1)"),
            ("scrollbar-track", "transparent"),
            ("selection-bg", "rgba(31, 35, 40, 0.12)"),
            ("titlebar-bg", "#fafafa"),
            ("titlebar-text", "#1f2328"),
            ("titlebar-border", "rgba(0, 0, 0, 0.06)"),
            ("activitybar-bg", "#fafafa"),
            ("activitybar-border", "rgba(0, 0, 0, 0.06)"),
            ("sidebar-bg", "#f4f4f4"),
            ("sidebar-border", "rgba(0, 0, 0, 0.08)"),
            ("editor-bg", "#fafafa"),
            ("editor-gutter", "#fafafa"),
            ("statusbar-bg", "#f4f4f4"),
            ("statusbar-border", "rgba(0, 0, 0, 0.06)"),
            ("statusbar-text", "#444d56"),
            ("tab-active-bg", "#fafafa"),
            ("tab-inactive-bg", "#f4f4f4"),
            ("tab-border", "rgba(0, 0, 0, 0.08)"),
            ("panel-bg", "#fafafa"),
            ("panel-border", "rgba(0, 0, 0, 0.08)"),
            ("input-bg", "#ffffff"),
            ("input-border", "rgba(0, 0, 0, 0.1)"),
            ("input-focus-border", "rgba(31, 35, 40, 0.55)"),
            ("button-bg", "#1f2328"),
            ("button-hover-bg", "#0d1117"),
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
