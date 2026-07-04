use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub theme_type: ThemeType,
    pub colors: HashMap<String, String>,
    pub syntax: HashMap<String, String>,
    #[serde(default)]
    pub background_image: Option<String>,
    #[serde(default)]
    pub background_opacity: Option<f32>,
    #[serde(default)]
    pub background_blur: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeType {
    Dark,
    Light,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub theme_type: ThemeType,
}

impl From<&Theme> for ThemeInfo {
    fn from(theme: &Theme) -> Self {
        ThemeInfo {
            id: theme.id.clone(),
            name: theme.name.clone(),
            theme_type: theme.theme_type.clone(),
        }
    }
}
