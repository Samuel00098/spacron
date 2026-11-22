# Grey square tiles over the app (Windows)

Seen 2026-11-22 in the installed build: light-grey squares in a regular grid
over the chat while scrolling. Not caused by CSS: it stayed with the background
image off and panel opacity at 100, and no rule draws grey squares.

- The squares are WebView2 compositor tiles that failed to draw. They look grey
  because the window's acrylic (`apply_acrylic` in `src-tauri/src/lib.rs`)
  shows through the hole.
- The user's machine has two GPUs (Intel UHD 630 + AMD Radeon Pro WX 3200),
  the classic trigger. The app had been running for ~7 hours.
- Restarting the app fixed it. At the same time the user pinned the app to the
  Intel GPU in Windows graphics settings, so which of the two fixed it is unknown.

Before restyling panels for a "rendering glitch", check whether it survives
turning the image and blur off, and whether a restart clears it. The code-side
options considered but not taken: start WebView2 with GPU flags, or drop the
window acrylic so a missing tile shows dark instead of grey.
