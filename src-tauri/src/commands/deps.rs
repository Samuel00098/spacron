//! Central catalog of the external system dependencies Spacron relies on, plus
//! a helper for building a clear, per-platform "here's what to install" message.
//!
//! Spacron can't bundle these — they're system components (Git, the Android SDK
//! tools, GStreamer codecs, espeak-ng, …) that live on the user's own machine
//! and are frequently patent- or license-gated by the distro. So when a feature
//! can't run because one is missing, the best thing we can do is tell *that*
//! user, on *their* OS, exactly what to install. Keeping the instructions in one
//! place means every command surfaces the same helpful, cross-platform guidance
//! instead of a silent failure or a hint that only makes sense on one OS.

/// An external dependency and how to install it on each supported platform.
pub struct Dependency {
    /// Friendly name shown to the user, e.g. "Git".
    pub name: &'static str,
    /// What Spacron needs it for, phrased for a user (one sentence).
    pub purpose: &'static str,
    /// Install guidance for Linux — cover the common package managers.
    pub linux: &'static str,
    /// Install guidance for macOS.
    pub macos: &'static str,
    /// Install guidance for Windows.
    pub windows: &'static str,
}

impl Dependency {
    /// The install guidance for the OS we're currently running on.
    pub fn install_hint(&self) -> &'static str {
        match std::env::consts::OS {
            "macos" => self.macos,
            "windows" => self.windows,
            // Everything else is treated as a Linux/Unix desktop.
            _ => self.linux,
        }
    }

    /// A full user-facing message: what's missing, why it matters, and the exact
    /// command to fix it on this platform. Ends by telling the user to restart,
    /// since most of these are resolved on the next launch.
    pub fn missing_message(&self) -> String {
        format!(
            "{} isn't installed or isn't on your PATH. {}\n\nTo fix it — {}\n\nThen restart Spacron.",
            self.name,
            self.purpose,
            self.install_hint()
        )
    }
}

/// Git — required for the source-control panel, diffs, and commit history.
pub const GIT: Dependency = Dependency {
    name: "Git",
    purpose: "Spacron uses Git for the source-control panel, file diffs, and commit history.",
    linux: "Debian/Ubuntu: `sudo apt install git`  •  Fedora: `sudo dnf install git`  •  Arch: `sudo pacman -S git`.",
    macos: "install the Xcode Command Line Tools with `xcode-select --install`, or run `brew install git`.",
    windows: "install Git for Windows from https://git-scm.com and make sure it's on your PATH.",
};

/// Xcode's command-line tools (`xcrun`/`simctl`) — required for the iOS panel.
/// Unlike the others, this genuinely can't be installed off macOS: Apple's iOS
/// Simulator only exists there, so the Linux/Windows guidance explains that
/// rather than pretending there's a package to install.
pub const XCODE: Dependency = Dependency {
    name: "Xcode's command-line tools (xcrun/simctl)",
    purpose: "Spacron's iOS panel drives simulators through Apple's `xcrun simctl`.",
    linux: "iOS simulators only run on macOS — there's no way to run them on Linux. Use the Android panel here, or switch to a Mac for iOS.",
    macos: "install Xcode from the App Store, then run `xcode-select --install` so `xcrun` is on your PATH.",
    windows: "iOS simulators only run on macOS — there's no way to run them on Windows. Use the Android panel here, or switch to a Mac for iOS.",
};

/// The Android SDK platform-tools / emulator — required for the mobile panel.
pub const ANDROID_SDK: Dependency = Dependency {
    name: "The Android SDK command-line tools",
    purpose: "Spacron's mobile tools drive your devices and emulators through `adb` and `emulator`.",
    linux: "install Android Studio (which bundles the SDK), or the standalone command-line tools from https://developer.android.com/tools, then add `platform-tools` and `emulator` to your PATH — or set ANDROID_HOME.",
    macos: "run `brew install --cask android-platform-tools` (or install Android Studio), then set ANDROID_HOME if the tools aren't on your PATH.",
    windows: "install Android Studio or the standalone SDK command-line tools from https://developer.android.com/tools, then add `platform-tools` and `emulator` to your PATH — or set ANDROID_HOME.",
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_message_mentions_name_and_a_hint() {
        let msg = GIT.missing_message();
        assert!(msg.contains("Git"));
        assert!(msg.contains("restart Spacron"));
        // The message must always carry a concrete, non-empty install hint.
        assert!(!GIT.install_hint().is_empty());
        assert!(!ANDROID_SDK.install_hint().is_empty());
    }
}
