const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Debug, PartialEq)]
pub(crate) struct Display {
    pub physical_id: String,
    pub width: u32,
    pub height: u32,
    pub port: u32,
}

/// Read the powered internal panel, rather than assuming display zero is lit.
pub(crate) fn active_display(dump: &str) -> Option<Display> {
    dump.split("DisplayDeviceInfo{").skip(1).find_map(|block| {
        let block = block.split("\n").next()?;
        if !block.contains("state ON,") || !block.contains("type INTERNAL") { return None; }
        let rest = block.split("uniqueId=\"local:").nth(1)?;
        let (id, rest) = rest.split_once('"')?;
        if !id.bytes().all(|b| b.is_ascii_digit()) { return None; }
        let dimensions = rest.trim_start_matches(", ").split(',').next()?;
        let (w, h) = dimensions.split_once(" x ")?;
        let port = block.split("port=").nth(1)?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
        Some(Display { physical_id: id.into(), width: w.trim().parse().ok()?, height: h.trim().parse().ok()?, port })
    })
}

pub(crate) fn committed_posture(dump: &str) -> Option<&str> {
    let line = dump.lines().find(|line| line.trim_start().starts_with("mCommittedState="))?;
    let name = line.split("name='").nth(1)?.split('\'').next()?;
    match name { "CLOSED" => Some("closed"), "OPENED" | "OPEN" => Some("opened"), "HALF_OPENED" | "HALF_OPEN" => Some("half_opened"), _ => None }
}

/// Some Android builds prepend screencap's multi-display warning to stdout,
/// even with exec-out. Preserve the binary payload without text conversion.
pub(crate) fn png_payload(output: &[u8]) -> Result<&[u8], String> {
    let offset = output
        .windows(PNG_SIGNATURE.len())
        .take(4096)
        .position(|bytes| bytes == PNG_SIGNATURE)
        .ok_or_else(|| "Screen capture returned no PNG image (the display may be changing or unavailable)".to_string())?;
    Ok(&output[offset..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_lit_cover_instead_of_dark_inner_panel() {
        let dump = "DisplayDeviceInfo{uniqueId=\"local:123\", 2000 x 2100, type INTERNAL, port=0}, state OFF,\nDisplayDeviceInfo{uniqueId=\"local:456\", 1080 x 2364, type INTERNAL, port=1}, state ON,";
        assert_eq!(active_display(dump).unwrap(), Display { physical_id: "456".into(), width: 1080, height: 2364, port: 1 });
        assert!(active_display("DisplayDeviceInfo{type EXTERNAL, state ON,").is_none());
    }

    #[test]
    fn reports_committed_not_pending_posture() {
        assert_eq!(committed_posture("mCommittedState=Optional[DeviceState{identifier=0, name='CLOSED'}]\nmPendingState=name='OPENED'"), Some("closed"));
        assert_eq!(committed_posture("mCommittedState=Optional.empty"), None);
    }

    #[test]
    fn preserves_clean_png_bytes() {
        let bytes = b"\x89PNG\r\n\x1a\n\x00\xff\r\n";
        assert_eq!(png_payload(bytes).unwrap(), bytes);
    }

    #[test]
    fn removes_foldable_multi_display_warning_without_altering_binary() {
        let mut output = b"[Warning] Multiple displays were found, but no display id was specified!\n".to_vec();
        let image = b"\x89PNG\r\n\x1a\n\x00\xff\r\n";
        output.extend_from_slice(image);
        assert_eq!(png_payload(&output).unwrap(), image);
    }

    #[test]
    fn rejects_empty_or_diagnostic_only_output() {
        assert!(png_payload(b"").is_err());
        assert!(png_payload(b"Failed to capture display").is_err());
    }
}
