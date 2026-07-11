// Copy install command
function copyInstallCommand() {
  const codeText = document.getElementById('install-cmd').innerText;
  navigator.clipboard.writeText(codeText).then(() => {
    const copyBtn = document.querySelector('.copy-btn');
    const originalSvg = copyBtn.innerHTML;
    copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
    setTimeout(() => {
      copyBtn.innerHTML = originalSvg;
    }, 2000);
  });
}

// Platform detection for download link
window.addEventListener('DOMContentLoaded', () => {
  const detectEl = document.getElementById('platform-detect');
  const downloadBtn = document.getElementById('download-btn');
  const installCmd = document.getElementById('install-cmd');

  const userAgent = window.navigator.userAgent.toLowerCase();

  if (userAgent.indexOf('win') !== -1) {
    detectEl.textContent = 'windows x64 · .exe installer';
    downloadBtn.textContent = 'Download for Windows';
    downloadBtn.href = 'https://github.com/Samuel00098/spacron/releases/latest/download/Spacron_x64-setup.exe';
    installCmd.textContent = 'winget install Samuel00098.Spacron';
  } else if (userAgent.indexOf('mac') !== -1) {
    detectEl.textContent = 'macos · .dmg disk image';
    downloadBtn.textContent = 'Download for macOS';
    downloadBtn.href = 'https://github.com/Samuel00098/spacron/releases/latest/download/Spacron_aarch64.dmg';
    installCmd.textContent = 'brew install Samuel00098/spacron';
  } else if (userAgent.indexOf('linux') !== -1) {
    detectEl.textContent = 'linux · .AppImage / .deb';
    downloadBtn.textContent = 'Download for Linux';
    downloadBtn.href = 'https://github.com/Samuel00098/spacron/releases/latest';
    installCmd.textContent = 'snap install spacron';
  } else {
    detectEl.textContent = 'windows · macos · linux';
    downloadBtn.textContent = 'Download';
    downloadBtn.href = 'https://github.com/Samuel00098/spacron/releases/latest';
  }
});
