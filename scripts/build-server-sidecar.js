/**
 * Builds the headless `spacron-server` binary and stages it as a Tauri
 * **sidecar** so every app installer (.msi / .dmg / .deb / .AppImage) carries
 * it. The desktop app then ships with the server it needs to set up a remote
 * workspace on a VPS (see the in-app "Set up a remote VPS" wizard).
 *
 * Tauri's `bundle.externalBin` convention: a sidecar named `spacron-server`
 * must exist as `src-tauri/binaries/spacron-server-<target-triple>[.exe]` at
 * bundling time. Tauri strips the triple when it copies the file next to the
 * app binary. This script:
 *
 *   1. compiles the server (`cargo build --release --no-default-features
 *      --bin spacron-server` — default features are dropped because the
 *      voice/whisper stack is desktop-only and would add a cmake requirement
 *      for nothing),
 *   2. copies `target/release/spacron-server[.exe]` to
 *      `binaries/spacron-server-<triple>[.exe]`.
 *
 * Pass `--target=<triple>` to build for another platform instead of the host;
 * the deploy wizard picks those artifacts up by name when the target server
 * runs a different OS than this machine:
 *
 *     npm run server:build -- --target=x86_64-unknown-linux-musl
 *
 * Cross-build notes:
 * - Linux targets: needs the rustup target (`rustup target add
 *   x86_64-unknown-linux-musl`) and a Linux-capable linker — on Windows/macOS
 *   use cargo-zigbuild (`cargo install cargo-zigbuild`, then run this script
 *   through it or ensure `zig` is on PATH). musl artifacts are static, so
 *   they run on any distro without runtime-library installs.
 * - Windows target: native from Windows; from other hosts needs the MSVC
 *   toolchain story (xwin etc.) — simplest built on Windows.
 * - macOS targets CANNOT be cross-built: build on a Mac or let CI do it,
 *   then drop the binary into src-tauri/binaries under its triple name.
 *
 * Run via `npm run server:build`, and automatically as part of
 * `beforeBuildCommand` so `tauri build` and the release CI pick it up.
 *
 * In `tauri dev` the sidecar is not copied next to the dev binary; the deploy
 * command falls back to `target/release` (or `SPACRON_SERVER_PATH`) so the
 * wizard still works locally after a `npm run server:build`.
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const tauriDir = path.join(repoRoot, 'src-tauri');

function run(command) {
  execSync(command, { stdio: 'inherit', cwd: tauriDir });
}

function hostTriple() {
  const out = execSync('rustc -vV', { encoding: 'utf8', cwd: tauriDir });
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('host:'));
  if (!line) {
    console.error('build-server-sidecar: could not read the host target triple from `rustc -vV`');
    process.exit(1);
  }
  return line.slice('host:'.length).trim();
}

/** `--target <triple>` or `--target=<triple>`; null = build for the host. */
function parseTargetArg() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') return argv[i + 1];
    if (argv[i].startsWith('--target=')) return argv[i].slice('--target='.length);
  }
  return null;
}

const requestedTarget = parseTargetArg();
const triple = requestedTarget || hostTriple();
// The `.exe` follows the TARGET OS, not the machine building it.
const ext = triple.includes('windows') ? '.exe' : '';

console.log(`build-server-sidecar: building spacron-server for ${triple}…`);
run(
  `cargo build --release --no-default-features --bin spacron-server${
    requestedTarget ? ` --target ${requestedTarget}` : ''
  }`,
);

// An explicit --target redirects cargo's output into target/<triple>/release.
const profileDir = requestedTarget
  ? path.join(tauriDir, 'target', requestedTarget, 'release')
  : path.join(tauriDir, 'target', 'release');
const built = path.join(profileDir, `spacron-server${ext}`);
if (!fs.existsSync(built)) {
  console.error(`build-server-sidecar: expected build output missing: ${built}`);
  process.exit(1);
}

const outDir = path.join(tauriDir, 'binaries');
fs.mkdirSync(outDir, { recursive: true });
const dest = path.join(outDir, `spacron-server-${triple}${ext}`);
fs.copyFileSync(built, dest);
console.log(`build-server-sidecar: sidecar ready at ${path.relative(repoRoot, dest)}`);
if (requestedTarget && triple !== hostTriple()) {
  console.log(
    'build-server-sidecar: cross artifact staged — the VPS wizard will find it by name when deploying to that OS.',
  );
}
