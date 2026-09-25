# Building whisper for Windows ARM64

`whisper-rs-sys` (whisper.cpp / ggml) does **not** build for
`aarch64-pc-windows-msvc` with MSVC: ggml's CMake stops with
`MSVC is not supported for ARM, use clang`. `cmake-rs` gives no env var to pick
the `ClangCL` VS toolset, so the working route (verified 2026-09-24 by
cross-compiling a linked probe on an x64 box) is:

- VS components: `VC.Tools.ARM64` + `VC.Llvm.Clang` + `VC.Llvm.ClangToolset`
- `vcvarsall.bat x64_arm64`, VS's Llvm `bin` on PATH, `CMAKE_GENERATOR=Ninja`
- `CC_/CXX_aarch64_pc_windows_msvc=clang-cl`,
  `CFLAGS_…=--target=arm64-pc-windows-msvc`,
  `CXXFLAGS_…=--target=arm64-pc-windows-msvc /EHsc`

`/EHsc` is required: cmake-rs replaces `CMAKE_CXX_FLAGS`, dropping it, and
clang-cl then rejects gguf.cpp's `try` ("exceptions disabled"). MSVC tolerated
that silently, which is why the x64 build never showed it.

Only compile + link was proven; nothing has run on ARM hardware yet.

Related: [[release-flow]]
