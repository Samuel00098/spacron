# `cargo check` fails on whisper-rs-sys inside an agent's sandboxed shell

Symptom: `failed to run custom build command for whisper-rs-sys`, and further
up `CMake Error … Generator Visual Studio 17 2022 could not find any instance
of Visual Studio`. Build Tools 2022 *is* installed; the sandboxed shell just
cannot run CMake's instance discovery. It is not a code problem.

Fix without disabling the sandbox: point CMake at the install directly
(PowerShell; check the version with `vswhere -all -products *`):

```powershell
$env:CMAKE_GENERATOR_INSTANCE = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools,version=17.14.37314.3"
cargo check
```

Changing that variable re-fingerprints the build script, so the first run
rebuilds whisper.cpp (about 5 minutes).
