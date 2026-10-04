#!/usr/bin/env node
/**
 * Writes public/third-party-licenses.txt: every third-party component a shipped
 * build contains, and the license text each one is used under. Vite copies
 * public/ into the bundle, so the APK and the desktop build carry the file and
 * Settings → Open-source licenses shows it.
 *
 * Rerun after changing dependencies (`npm run licenses` from app/) and commit
 * the result. Output is deterministic, so an unchanged tree gives no diff.
 *
 * Sources:
 *   Rust        `cargo metadata --locked` for app/src-tauri, per shipped target,
 *               normal dependencies only (build-scripts and dev-deps don't ship)
 *   JavaScript  app/package.json `dependencies`, resolved through node_modules
 *   Android     implementation(...) lines in the plugin and app Gradle files
 *   Assets      fonts and PDF.js data checked in under app/src
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(APP, "..");
const CANON = join(REPO, "licenses");
const OUT = join(APP, "public", "third-party-licenses.txt");
const SOURCE_URL = "https://github.com/amittenak47/pen-island";

// CI publishes APKs for all four Android ABIs; Windows is the desktop build.
const TARGETS = [
  "aarch64-linux-android",
  "armv7-linux-androideabi",
  "i686-linux-android",
  "x86_64-linux-android",
  "x86_64-pc-windows-msvc",
];

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense|thirdpartynotices)\b/i;

const readText = path => readFileSync(path, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
const canon = name => readText(join(CANON, name));

function licenseFiles(dir) {
  const files = readdirSync(dir).sort()
    .map(name => join(dir, name))
    .filter(p => LICENSE_FILE.test(basename(p)) && statSync(p).isFile());
  // REUSE-style crates keep their texts in LICENSES/.
  const reuse = join(dir, "LICENSES");
  if (existsSync(reuse) && statSync(reuse).isDirectory()) {
    for (const name of readdirSync(reuse).sort()) files.push(join(reuse, name));
  }
  return files;
}

/** The SPDX ids a plain `A OR B` / `A/B` expression offers; null when it has AND/WITH. */
function orTerms(expr) {
  if (/\b(AND|WITH)\b/.test(expr)) return null;
  return expr.replace(/[()]/g, "").split(/\s+OR\s+|\s*\/\s*/).map(s => s.trim());
}

/**
 * Texts to reproduce for one component. Dual-licensed `MIT OR Apache-2.0` is
 * most of crates.io; electing MIT keeps the file a fraction of the size.
 * NOTICE files always come along (Apache-2.0 §4(d)).
 */
function textsFor(expr, files, authors) {
  const notices = files.filter(f => /notice/i.test(basename(f)));
  const terms = orTerms(expr ?? "");
  const mit = files.find(f => /mit/i.test(basename(f)));
  let picked = terms?.includes("MIT") && mit && files.length > 1 ? [mit, ...notices] : files;
  picked = [...new Set(picked)];
  const texts = picked.map(readText).filter(Boolean);
  if (/LGPL-3\.0/.test(expr ?? "")) {
    // LGPLv3 is a set of additions to GPLv3; conveying it means conveying both.
    return [...texts, canon("LGPL-3.0.txt"), canon("GPL-3.0.txt")];
  }
  if (texts.length) return texts;
  // Nothing shipped with the package: fall back to the standard text.
  const header = `(The published package has no license file. Standard ${expr} text follows.)`;
  if (terms?.includes("MIT")) {
    const holders = authors?.length ? authors.join(", ") : "the authors";
    return [`${header}\n\nCopyright (c) ${holders}\n\n${MIT_TEXT}`];
  }
  if (terms?.includes("Apache-2.0")) return [`${header}\n\n${canon("Apache-2.0.txt")}`];
  return [`(The published package has no license file. License: ${expr ?? "unknown"}.)`];
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const cleanUrl = url => url?.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "");

// ---------------------------------------------------------------- Rust

function rustComponents() {
  const found = new Map();
  for (const target of TARGETS) {
    const out = execFileSync("cargo", [
      "metadata", "--format-version", "1", "--locked",
      "--manifest-path", join(APP, "src-tauri", "Cargo.toml"),
      "--filter-platform", target,
    ], { cwd: REPO, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] });
    const meta = JSON.parse(out.toString());
    const pkgs = new Map(meta.packages.map(p => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map(n => [n.id, n]));
    const stack = [meta.resolve.root];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      found.set(id, pkgs.get(id));
      for (const dep of nodes.get(id).deps) {
        if (dep.dep_kinds.some(k => k.kind === null)) stack.push(dep.pkg);
      }
    }
  }
  const vendored = join(REPO, "third_party");
  return [...found.values()]
    // Path crates are this repo's own, except the patched copies in third_party/.
    .filter(p => p.source !== null || !relative(vendored, p.manifest_path).startsWith(".."))
    .map(p => {
      const dir = dirname(p.manifest_path);
      const files = licenseFiles(dir);
      if (p.license_file) files.push(join(dir, p.license_file));
      return {
        name: p.name,
        version: p.version,
        license: p.license ?? (p.license_file ? `see ${p.license_file}` : "unknown"),
        url: p.repository ?? p.homepage ?? `https://crates.io/crates/${p.name}`,
        texts: textsFor(p.license, files, p.authors),
      };
    });
}

// ---------------------------------------------------------------- JavaScript

function npmDir(name, from) {
  for (let dir = from; !relative(APP, dir).startsWith(".."); dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === APP) break;
  }
  return null;
}

function npmComponents() {
  const root = JSON.parse(readFileSync(join(APP, "package.json"), "utf8"));
  const found = new Map();
  const queue = Object.keys(root.dependencies ?? {})
    .filter(n => !n.startsWith("@types/")) // type declarations never reach the bundle
    .map(name => ({ name, from: APP, optional: false }));
  while (queue.length) {
    const { name, from, optional } = queue.shift();
    const dir = npmDir(name, from);
    if (!dir) {
      if (!optional) throw new Error(`${name} is not installed; run npm ci in app/ first`);
      continue;
    }
    if (found.has(dir)) continue;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const license = typeof pkg.license === "string" ? pkg.license
      : pkg.license?.type ?? pkg.licenses?.map(l => l.type).join(" OR ") ?? "unknown";
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    found.set(dir, {
      name: pkg.name,
      version: pkg.version,
      license,
      url: cleanUrl(repo) ?? pkg.homepage ?? `https://www.npmjs.com/package/${pkg.name}`,
      texts: textsFor(license, licenseFiles(dir), pkg.author ? [pkg.author.name ?? pkg.author] : []),
    });
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir, optional: false });
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: dep, from: dir, optional: true });
  }
  return [...found.values()];
}

// ---------------------------------------------------------------- Android

function androidComponents() {
  const gradle = [join(APP, "src-tauri", "gen", "android", "app", "build.gradle.kts")];
  const plugins = join(APP, "src-tauri", "plugins");
  for (const name of readdirSync(plugins)) gradle.push(join(plugins, name, "android", "build.gradle.kts"));
  const coords = new Set();
  for (const file of gradle.filter(existsSync)) {
    for (const m of readFileSync(file, "utf8").matchAll(/implementation\("([\w.-]+):([\w.-]+):([\w.+-]+)"\)/g)) {
      coords.add(`${m[1]}:${m[2]}:${m[3]}`);
    }
  }
  const apache = canon("Apache-2.0.txt");
  const listed = [...coords].map(c => {
    const [group, artifact, version] = c.split(":");
    if (group.startsWith("com.google.mlkit")) {
      return {
        name: `${group}:${artifact}`, version, license: "ML Kit Terms of Service",
        url: "https://developers.google.com/ml-kit/terms",
        texts: ["Google ML Kit is proprietary software provided by Google under the ML Kit Terms of Service:\nhttps://developers.google.com/ml-kit/terms\nIt is not open source and is not covered by Pen Island's license."],
      };
    }
    return {
      name: `${group}:${artifact}`, version, license: "Apache-2.0",
      url: group.startsWith("androidx") ? "https://developer.android.com/jetpack/androidx"
        : "https://github.com/material-components/material-components-android",
      texts: [apache],
    };
  });
  // Gradle resolves further AndroidX and Kotlin artifacts transitively; all Apache-2.0.
  listed.push({
    name: "Transitive AndroidX and Kotlin standard library artifacts", version: "", license: "Apache-2.0",
    url: "https://developer.android.com/jetpack/androidx", texts: [apache],
  });
  return listed;
}

// ---------------------------------------------------------------- Bundled files

function assetComponents() {
  const assets = [
    ["PDF.js CMaps (Adobe)", "app/src/dist/cmaps/LICENSE", "BSD-3-Clause", "https://github.com/adobe-type-tools/cmap-resources"],
    ["PDF.js standard fonts (Foxit)", "app/src/dist/standard_fonts/LICENSE_FOXIT", "BSD-3-Clause", "https://github.com/mozilla/pdf.js"],
    ["PDF.js standard fonts (Liberation)", "app/src/dist/standard_fonts/LICENSE_LIBERATION", "OFL-1.1", "https://github.com/liberationfonts/liberation-fonts"],
    ["DINish font", "app/src/fonts/OFL.txt", "OFL-1.1", "https://github.com/playbeing/dinish"],
    ["libffi (C library, built into libffi-sys)", "third_party/libffi-sys/libffi/LICENSE", "MIT", "https://github.com/libffi/libffi"],
  ];
  return assets.map(([name, file, license, url]) => ({
    name, version: "", license, url, texts: [readText(join(REPO, file))],
  }));
}

// ---------------------------------------------------------------- Output

const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true });
const groups = [
  ["Rust crates", rustComponents().sort(byName)],
  ["JavaScript packages", npmComponents().sort(byName)],
  ["Android libraries", androidComponents().sort(byName)],
  ["Fonts and other bundled files", assetComponents()],
];

// Identical texts (the Apache-2.0 body, a shared MIT notice) print once.
const texts = new Map();
for (const [, list] of groups) {
  for (const c of list) {
    c.ids = c.texts.map(text => {
      const key = createHash("sha256").update(text.replace(/\s+/g, " ")).digest("hex");
      if (!texts.has(key)) texts.set(key, { id: texts.size + 1, text, users: [] });
      const entry = texts.get(key);
      entry.users.push(c.version ? `${c.name} ${c.version}` : c.name);
      return entry.id;
    });
  }
}

const lgpl = groups[0][1].filter(c => /LGPL-3\.0/.test(c.license));
const rule = "=".repeat(78);
const lines = [
  "PEN ISLAND: THIRD-PARTY NOTICES",
  "",
  "Pen Island is licensed under the PolyForm Noncommercial License 1.0.0. That",
  "license covers Pen Island's own code only. The components below belong to",
  "their own authors and are used under their own licenses, reproduced in full",
  "in the second half of this file.",
  "",
  "This list covers the Practice and Whiteboard builds for Android and Windows.",
  "The Whiteboard build leaves out the Python judge (RustPython and its",
  "dependencies, including the LGPL components below).",
  "",
  `Source: ${SOURCE_URL}`,
  "Generated by app/scripts/third-party-notices.mjs. Do not edit by hand.",
];
const wrap = text => text.match(/.{1,78}(\s|$)|\S+/g).map(s => s.trimEnd());
if (lgpl.length) {
  const repos = [...new Set(lgpl.map(c => c.url))].join(", ");
  lines.push(
    "",
    "LGPL-3.0 COMPONENTS",
    "",
    ...wrap(`The Practice build links ${lgpl.map(c => `${c.name} ${c.version}`).join(", ")} `
      + `(LGPL-3.0-only) statically, through RustPython. Their source is at ${repos}.`),
    "",
    ...wrap("You may modify these libraries and relink Pen Island against your modified copy. "
      + "Pen Island's complete source, with the exact dependency versions in "
      + `app/src-tauri/Cargo.lock, is at ${SOURCE_URL}; add a [patch.crates-io] entry `
      + "pointing at your copy and rebuild as the README describes. Notwithstanding Pen "
      + "Island's own license, you may modify those portions of the libraries and reverse "
      + "engineer Pen Island to debug such modifications, as section 4 of the LGPL-3.0 requires."),
  );
}
for (const [title, list] of groups) {
  lines.push("", rule, `${title.toUpperCase()} (${list.length})`, rule, "");
  for (const c of list) {
    lines.push(`${c.name}${c.version ? ` ${c.version}` : ""}`);
    lines.push(`    ${c.license}  ·  ${c.url}  ·  text ${c.ids.map(id => `[${id}]`).join(" ")}`);
  }
}
lines.push("", rule, "LICENSE TEXTS", rule);
for (const { id, text, users } of texts.values()) {
  lines.push("", "-".repeat(78), `[${id}] Used by: ${users.join(", ")}`, "-".repeat(78), "", text);
}

writeFileSync(OUT, `${lines.join("\n")}\n`);
const counts = groups.map(([title, list]) => `${list.length} ${title.toLowerCase()}`).join(", ");
console.log(`Wrote ${relative(REPO, OUT)}: ${counts}; ${texts.size} distinct license texts.`);
