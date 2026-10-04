# Third-party notices

Pen Island's own code is licensed under [PolyForm Noncommercial 1.0.0](LICENSE).
The libraries, fonts and data it ships with belong to their own authors and are
used under their own licenses.

**The full list, with every license text, is
[app/public/third-party-licenses.txt](app/public/third-party-licenses.txt).**
Every build carries that file, and the app shows it under
**Settings → Personalize → Licenses**.

## What's in it

| Source | Licenses |
| --- | --- |
| Rust crates (~550) | Mostly MIT or Apache-2.0; also BSD, ISC, Zlib, MPL-2.0, Unicode-3.0, BSL-1.0, PSF-2.0, and LGPL-3.0 (below) |
| JavaScript packages (~30, runtime only) | MIT, Apache-2.0 (PDF.js, Readability), MPL-2.0 or Apache-2.0 (DOMPurify), ISC, BSD |
| Android libraries | AndroidX and Material Components: Apache-2.0. Google ML Kit digital ink recognition: proprietary, [ML Kit Terms](https://developers.google.com/ml-kit/terms) |
| Fonts and data | DINish and Liberation fonts: OFL-1.1. Foxit fonts and Adobe CMaps for PDF.js: BSD-3-Clause |

Development-only tools (Vite, Vitest, TypeScript, the Tauri CLI) don't ship and
aren't listed.

## LGPL-3.0: malachite

The Practice build runs Python through RustPython, which uses the
[malachite](https://github.com/mhogrefe/malachite) big-integer crates
(`malachite-base`, `-nz`, `-q`, `-bigint`; LGPL-3.0-only). Rust links them
statically. To meet the LGPL:

- the LGPL-3.0 and GPL-3.0 texts are in [licenses/](licenses) and in the notices file;
- this repository is the complete source, and `app/src-tauri/Cargo.lock` pins the
  exact versions, so anyone can rebuild against a modified malachite with a
  `[patch.crates-io]` entry;
- the notices file grants the LGPL-3.0 §4 permission to modify those libraries
  and reverse-engineer Pen Island to debug such modifications, notwithstanding
  Pen Island's own license.

The Whiteboard build leaves out RustPython and contains no LGPL code.

## Problem sets

Problem sets aren't bundled. They're downloaded in the app, and each has its own
license (see the README). KodCode-V1 is CC BY-NC 4.0, noncommercial only.

## Updating

After changing dependencies, regenerate the list and commit it:

```bash
npm --prefix app run licenses
```

The script (`app/scripts/third-party-notices.mjs`) reads `cargo metadata` for
every shipped target (four Android ABIs and Windows), the runtime npm tree, and
the Gradle files. Output is deterministic, so an unchanged tree gives no diff.
