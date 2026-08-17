Vendored pymath 0.2.0 (PSF-2.0) from crates.io.

Upstream `malachite-bigint` req is `"0"` (any 0.x). Unlocked cargo
resolve picks 0.10.0. rustpython-stdlib 0.5 wants `^0.9`. Two `BigInt`
types, `cargo install --path .` fails without `--locked`.

This copy pins `malachite-bigint = "=0.9.2"` so a fresh resolve
(including `cargo install` which ignores `Cargo.lock`) unifies on 0.9.2.

Upstream: https://github.com/RustPython/pymath
