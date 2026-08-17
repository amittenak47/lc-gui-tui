# libffi (patched)

Copy of [libffi 5.2.0](https://crates.io/crates/libffi/5.2.0) Rust sources.

Upstream `system` enables `libffi-sys/system`, which links `-lffi` from the
OS. Android NDK has no libffi. This patch keeps the `system` feature (RustPython
turns it on) as a no-op so `libffi-sys` builds C libffi from source.

Needs `sh`, `cp`, and `make` on the host (Git bash + make on Windows).
