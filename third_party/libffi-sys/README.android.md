# libffi-sys 4.2.1 (patched)

Vendored from crates.io so Android/Windows can build RustPython ctypes.

Edits in `build/not_msvc.rs`:

1. Pass `CC` with forward slashes (libtool treats `\` as escape).
2. After configure, rewrite libtool's `-print-multi-os-directory` probe.
   NDK clang rejects that gcc flag.
3. Set `AR`/`RANLIB`/`NM`/`STRIP` to NDK `llvm-*` (else libtool uses `false`).
4. Link `libclang_rt.builtins-*-android.a` so `__clear_cache` (from
   `ffi_clear_cache`) is inside the APK `.so`. NDK 29 leaves it undefined;
   the tablet's loader then kills the app at the splash icon.
