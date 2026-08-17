#!/usr/bin/env python3
"""Zip seed corpora for the Tauri/APK resource bundle.

Does not commit jsonl. Reads already-fetched folders (or `--fetch`s them)
and writes:

    app/src-tauri/resources/corpora/leetcode.zip
    app/src-tauri/resources/corpora/leetcode-with-tests.zip

First launch extracts these into the device data-dir and indexes them.

    python scripts/pack_seed_corpora.py
    python scripts/pack_seed_corpora.py --fetch --data-dir ~/lc-data
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import zipfile
from pathlib import Path

SEED = ("leetcode", "leetcode-with-tests")
DEFAULT_DATA_DIR = os.path.expanduser(os.environ.get("LC_DATA_DIR", "~/lc-data"))
REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = REPO_ROOT / "app" / "src-tauri" / "resources" / "corpora"


def json_files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in {".json", ".jsonl"}
    )


def source_files(data_dir: Path, slug: str) -> tuple[Path, list[Path]]:
    nested = data_dir / slug
    nested_files = json_files(nested)
    if nested_files:
        return nested, nested_files
    if slug == "leetcode":
        root_files = [
            path
            for path in data_dir.iterdir()
            if path.is_file() and path.suffix.lower() in {".json", ".jsonl"}
        ]
        if root_files:
            return data_dir, sorted(root_files)
    return nested, []


def pack_slug(data_dir: Path, slug: str, dest: Path) -> int:
    source, files = source_files(data_dir, slug)
    if not files:
        raise FileNotFoundError(
            f"no .json/.jsonl under {source} — fetch with "
            f"`python scripts/fetch_dataset.py {slug}`"
        )
    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, arcname=path.name)
    return len(files)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir",
        default=DEFAULT_DATA_DIR,
        help="corpus root (default: %(default)s)",
    )
    parser.add_argument(
        "--fetch",
        action="store_true",
        help="run fetch_dataset.py for the seed slugs first",
    )
    opts = parser.parse_args()
    data_dir = Path(os.path.expanduser(opts.data_dir))
    if opts.fetch:
        fetch = REPO_ROOT / "scripts" / "fetch_dataset.py"
        cmd = [sys.executable, str(fetch), *SEED, "--data-dir", str(data_dir)]
        print(" ".join(cmd))
        subprocess.check_call(cmd)

    failed = []
    for slug in SEED:
        dest = OUT_DIR / f"{slug}.zip"
        print(f"{slug} -> {dest}")
        try:
            count = pack_slug(data_dir, slug, dest)
        except Exception as err:  # noqa: BLE001
            print(f"  failed: {err}", file=sys.stderr)
            failed.append(slug)
            continue
        size_mb = dest.stat().st_size / (1024 * 1024)
        print(f"  {count} file(s), {size_mb:.1f} MB")

    if failed:
        print(f"failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
