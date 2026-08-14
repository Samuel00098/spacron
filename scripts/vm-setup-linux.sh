#!/usr/bin/env bash
# Provision an Ubuntu 22.04 VM for running the Spacron desktop app (Full GUI
# model): desktop + RDP server + every runtime dependency the app needs.
#
#   sudo bash scripts/vm-setup-linux.sh
#
# After this, install the release .deb and remote in via RDP:
#   sudo apt install -y ./spacron_*.deb
#
# See docs/cloud-vm.md for the full runbook (Windows notes, TLS, verification).
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/vm-setup-linux.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update

# Desktop + RDP server. ubuntu-desktop-minimal keeps the install lean; XFCE is
# used when a lighter desktop is preferred.
apt-get install -y --no-install-recommends \
  ubuntu-desktop-minimal xrdp xorgxrdp dbus-x11 \
  || apt-get install -y xrdp xorgxrdp xfce4 dbus-x11

# Runtime deps of the Tauri app itself:
#   libwebkit2gtk-4.1-0       - WebView (the whole UI renders here)
#   libgtk-3-0                - windowing toolkit
#   libayatana-appindicator3-1- system-tray icon
#   librsvg2-2                - SVG rendering (icons, wallpapers)
#   gnome-keyring libsecret-1-0 - secret-service daemon; Spacron's token
#                                 storage (keyring crate) fails without it
#   gstreamer1.0-*            - media playback in the app
#   ca-certificates curl unzip - pulling the release binary and tools
apt-get install -y \
  libwebkit2gtk-4.1-0 \
  libgtk-3-0 \
  libayatana-appindicator3-1 \
  librsvg2-2 \
  gnome-keyring \
  libsecret-1-0 \
  libgstreamer1.0-0 \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  ca-certificates curl unzip

# xrdp's startwm.sh must exec a session; append whichever desktop exists.
# Idempotent: re-running the script must not stack sessions.
SESSION_LINE=$(command -v gnome-session || command -v xfce4-session || true)
if [[ -n "$SESSION_LINE" ]] && ! grep -qF "$SESSION_LINE" /etc/xrdp/startwm.sh; then
  echo "$SESSION_LINE" >> /etc/xrdp/startwm.sh
fi
systemctl enable xrdp --now
systemctl restart xrdp || true

echo
echo "=== Done. Next steps ==="
echo "1. Install the app:   sudo apt install -y ./spacron_*.deb"
echo "   (grab it from the latest GitHub release — .deb for Ubuntu)"
echo "2. Remote in over RDP with the user you log in as here (Remmina / xfreerdp /"
echo "   Windows mstsc). If the session shows a blank screen:"
echo "       sudo systemctl restart xrdp"
echo "3. Launch Spacron from the app menu. WEBKIT_DISABLE_DMABUF_RENDERER=1 is"
echo "   set by the app itself, so GPU-less VM video works out of the box."
echo "4. Secure RDP: prefer Tailscale; never expose port 3389 raw to the"
echo "   internet. See docs/cloud-vm.md."
