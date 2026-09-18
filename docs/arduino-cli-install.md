# Installing Arduino CLI (Windows manual install)

Spacron's Embedded panel drives `arduino-cli` from the terminal, so the tool must be
installed on PATH. The `winget` route was chosen because the GitHub CDN download kept
timing out. If the 17 MB binary download keeps failing from inside the terminal, use the
MSI installer from a normal browser window — it is the same file, served by the same CDN,
but the browser is usually more resilient at resuming.

## Option 1 — winget (easiest)

Open a terminal (any of: PowerShell, cmd) and run:

```powershell
winget install --id ArduinoSA.CLI --exact --accept-package-agreements --accept-source-agreements
```

This installs `arduino-cli.exe` and adds it to PATH for future terminals. Close and reopen
your terminal before using it.

## Option 2 — MSI installer (most reliable if the download keeps failing)

1. Open this page in a normal browser:
   <https://github.com/arduino/arduino-cli/releases>
2. Download `arduino-cli_<version>_Windows_64bit.msi` (the latest release).
3. Run the MSI and accept the defaults.

## Option 3 — portable zip (no admin rights)

1. In the browser, download `arduino-cli_<version>_Windows_64bit.zip` from the same
   releases page.
2. Extract it to `C:\Users\<you>\AppData\Local\Programs\arduino-cli\` (the zip contains a
   single `arduino-cli.exe`).
3. Add that folder to your PATH:
   - Windows key → type `env` → "Edit environment variables for your account"
   - Under **User variables**, select `Path` → **Edit** → **New** → paste the folder path.
   - OK everywhere, then close and reopen terminals.

## Verify

In a NEW terminal:

```powershell
arduino-cli version
arduino-cli config init
arduino-cli core update-index
arduino-cli core install arduino:avr
```

Connect an Arduino, then:

```powershell
arduino-cli board list
```

You should see your board and its COM port. Spacron's Embedded panel has the settings for
FQBN (default `arduino:avr:uno`) and port (default `COM3`) on the Arduino tab.

## Optional: PlatformIO (for the PlatformIO tab in Spacron)

Spacron's PlatformIO tab shells out to `pio`. Install it once:

```powershell
pip install -U platformio
```

(Or use the PlatformIO VS Code extension's bundled `pio` binary if you prefer not to add
Python to PATH.)