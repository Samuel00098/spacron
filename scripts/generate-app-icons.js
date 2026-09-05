import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const icons = join(root, 'src-tauri/icons');
const source = readFileSync(join(icons, 'app-icon-source.svg'), 'utf8');
const temporary = mkdtempSync(join(tmpdir(), 'spacron-icons-'));
const cli = join(root, 'node_modules/@tauri-apps/cli/tauri.js');
const generate = (input, output, sizes = []) => execFileSync(process.execPath,
  [cli, 'icon', input, '--output', output, '--ios-color', '#070708', ...sizes.flatMap(size => ['--png', String(size)])],
  { cwd: root, stdio: 'inherit' });

try {
  generate(join(icons, 'app-icon-source.svg'), icons);
  const darkSource = join(temporary, 'dark.svg');
  writeFileSync(darkSource, source.replace(
    '0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0',
    '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0'));
  generate(darkSource, temporary, [32, 512]);
  copyFileSync(join(icons, 'icon.png'), join(root, 'static/icon.png'));
  copyFileSync(join(icons, 'icon.png'), join(icons, 'app-icon-source.png'));
  copyFileSync(join(icons, '32x32.png'), join(root, 'static/favicon.png'));
  copyFileSync(join(temporary, '512x512.png'), join(root, 'static/icon-dark.png'));
  copyFileSync(join(temporary, '32x32.png'), join(root, 'static/favicon-dark.png'));
} finally {
  // mkdtemp creates this task-owned directory; never remove an input directory.
  if (resolve(temporary).startsWith(resolve(tmpdir()) + '\\') || resolve(temporary).startsWith(resolve(tmpdir()) + '/')) {
    rmSync(temporary, { recursive: true, force: true });
  }
}
