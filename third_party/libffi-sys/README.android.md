# libffi-sys 4.2.1 (patched)

Vendored from crates.io so Android/Windows can build RustPython ctypes.

Edits in `build/not_msvc.rs`:

1. Pass `CC` with forward slashes (libtool treats `\` as escape).
2. After configure, rewrite libtool's `-print-multi-os-directory` probe.
   NDK clang rejects that gcc flag.
3. Set `AR`/`RANLIB`/`NM`/`STRIP` to NDK `llvm-*` (else libtool uses `false`).
