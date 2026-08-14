# Running Spacron on a Cloud VM (Full GUI)

This is the **Full GUI** model: install the whole Spacron desktop app on a VM and
remote-desktop into it. The workspace, terminals, LSP, and agents all run on the VM —
agents spawned from the app run there automatically. No thin-client plumbing needed.

> The alternative, a headless `spacron-server` you attach to from a local app, is
> documented in `docs/remote-workspace.md`. Both models share the same code; the
> VM choice below is purely "how do you want to use it".

---

## Choose the VM

| | **Windows** (smoothest) | **Linux (Ubuntu 22.04)** (budget) |
|---|---|---|
| Remote desktop | RDP, built in | `xrdp` (script below) |
| GUI runtime deps | WebView2 (preinstalled on Win10/11) | webkit2gtk + GStreamer + keyring (script below) |
| Release binary | `.msi` from GitHub Releases | `.deb` from GitHub Releases |
| Minimum size | 2 vCPU / 8 GB RAM | 2 vCPU / 8 GB RAM |

Recommendations:

- **Windows** if you want the least setup: install the `.msi`, enable RDP, log in.
- **Ubuntu 22.04** if you want the cheaper box (and it matches the CI platform the
  Linux builds are tested on). The provisioning script handles everything.
- Disk: give the VM room for repos + worktrees — 100 GB SSD is comfortable.

## Get the binary

Download the latest release from GitHub (the `release.yml` workflow builds
`.msi`/`.dmg`/`.deb` on tag push):

```
https://github.com/<owner>/<repo>/releases/latest
```

On Windows: run the `.msi`. On Ubuntu: `sudo apt install -y ./spacron_*.deb`
(or use the provisioning script below, which includes it as a step).

## Windows VM — steps

1. Install the `.msi` (WebView2 comes with Windows).
2. Enable RDP: Settings → System → Remote Desktop → On. Or
   `Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0` then open firewall port 3389 (`New-NetFirewallRule -DisplayName RDP -Direction Inbound -Protocol TCP -LocalPort 3389 -Action Allow`).
3. **Lock it down**: never expose 3389 raw to the internet. Options, in order of preference:
   - **Tailscale** on the VM + your laptop; RDP to the Tailscale IP (no open port).
   - Azure/AWS security group scoped to your home IP only.
4. Connect from Windows: `mstsc`. From macOS: Microsoft Remote Desktop app. From
   Linux: `xfreerdp` or Remmina.
5. Run Spacron inside the session and use it normally. Optionally set the app to
   auto-start with the session so a reboot leaves it running (create a shortcut in
   `shell:startup`).

## Linux VM — steps

Run the provisioning script once as root:

```bash
sudo bash scripts/vm-setup-linux.sh            # installs desktop + xrdp + app deps
```

It installs and enables `xrdp`, so after a reboot you can remote in. Then:

1. Download the `.deb` and install: `sudo apt install -y ./spacron_*.deb`
   (the script prints this reminder).
2. Remote in via RDP (Remmina / xfreerdp / Windows `mstsc`). First login may need
   `sudo systemctl restart xrdp` if the session doesn't start.
3. Log in with the user you created (or the existing account). The keyring
   (`gnome-keyring`) auto-unlocks on login, which is what Spacron's token storage
   (`keyring` crate) needs.
4. Run Spacron from the app menu. `WEBKIT_DISABLE_DMABUF_RENDERER=1` is set by the
   app itself, so no env tweak is needed for VMware/QEMU-style GPU-less video.
5. Optional auto-start: add Spacron to `~/.config/autostart/` so a VM reboot
   brings it back up.

### Why the script installs what it does

- `ubuntu-desktop-minimal` / `xfce4` — a desktop for the RDP session.
- `xrdp` + `xorgxrdp` — RDP server for Linux.
- `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`, `librsvg2-2` —
  WebView runtime + tray icon + SVG rendering for the Tauri app.
- `gnome-keyring`, `libsecret-1-0`, `dbus-x11` — the secret-service daemon the
  `keyring` crate talks to (without it, "keychain unavailable" errors).
- `gstreamer1.0-plugins-base/good` + `libgstreamer1.0-0` — media playback in the app.
- `ca-certificates`, `curl`, `unzip` — everything else you'll need to grab the
  release and toolchains.

---

## Remote-workspace TLS (both platforms)

If you also want the *thin-client* attach (`spacron-server` on the VM, app on your
laptop) — or just to harden it — the server now ships TLS:

```bash
spacron-server --workspace ~/code/myrepo --token "$TOKEN" --cert server.pem --key server.key
# serves wss://host:9000/pty; without --cert/--key it prints the plaintext warning
```

- Public CA (Let's Encrypt, Tailscale cert): works with zero client setup.
- Self-signed CA: install it in the **client's** OS trust store — the relay
  verifies against the OS store (`rustls-platform-verifier`), so a private CA
  validates once installed.
- Full design + token/transport details: `docs/remote-workspace.md`.

## Verification checklist

- [ ] Remote desktop session connects (RDP).
- [ ] App opens and the titlebar resource chip shows real CPU/RAM.
- [ ] A terminal spawns and the shell works.
- [ ] Spawn an agent from the Agents pane — it runs on the VM (watch the process
      list / resource panel).
- [ ] If using remote-workspace: `spacron-server` reachable over `wss://`, relay
      connects, token rejected when wrong.