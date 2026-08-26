# Windows PATH resolution: prefer `.cmd` shims, never the bare script

`src-tauri/src/lsp/registry.rs` resolves language servers and their installers off
`PATH` itself (no `which` crate). On Windows this has a trap worth remembering
anywhere in the codebase that spawns a Node-installed tool.

## The trap

npm and the Node installer write **two** files with the same stem into the same
directory:

| file | what it is |
| --- | --- |
| `npm`, `typescript-language-server` | a `#!/usr/bin/env bash` script, for MSYS/Cygwin |
| `npm.cmd`, `typescript-language-server.cmd` | the Windows batch shim |

`CreateProcess` (i.e. `std::process::Command`) can only run the `.cmd`. Handing it
the extensionless script fails with:

```
%1 is not a valid Win32 application. (os error 193)
```

`cmd.exe` never runs an extensionless file for a bare name — it only tries
`PATHEXT` variants. Our resolver must do the same.

## The rules

1. **Extension-bearing candidates outrank the bare name**, and they outrank it
   *across the whole PATH* — not just within one directory. `find_on_path` runs
   two passes (`candidate_passes`): every `PATHEXT` variant in every directory
   first, the extensionless name only as a last-resort fallback. A single-pass
   dir-major loop lets an early directory holding only the bash script shadow the
   `.cmd` further down PATH.
2. **`.cmd`/`.bat` must be wrapped in `cmd /c`** — `build_command` does this. They
   are not executables either.

## Why both halves matter

The original bug looked like "auto-install is broken" (`npm` → os error 193), but
installing the server by hand did *not* fix it: `resolve()` then found the
extensionless `typescript-language-server` shim and failed identically at spawn
time. Fixing the ordering fixed both paths at once.

Regression tests live in `registry.rs` under `#[cfg(all(test, windows))]`.
See also [[sidecar-externalbin-deadlock]] for the other Windows-only build trap.
