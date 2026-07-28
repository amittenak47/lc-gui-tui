#!/usr/bin/env python3
"""Download one of `lc`'s problem sets and write it where `lc index` looks.

Hugging Face ships these corpora as Parquet, which the Rust indexer cannot
read, so this converts them to `.jsonl` — one JSON object per row, columns
untouched.

**It deliberately knows nothing about the schemas.** Which column is the
statement, which is the entry point, which must never be read because it holds
a solution: all of that lives in `src/datasets/`, is tested there, and would
rot if it were duplicated here. This script only changes the file format.

    pip install -U huggingface_hub pyarrow

    python scripts/fetch_dataset.py kodcode
    python scripts/fetch_dataset.py --all --data-dir ~/lc-data
    python scripts/fetch_dataset.py deepseek-leetcode --out /tmp/ds

Then index what you downloaded:

    lc index --dataset kodcode

Exit code: 0 on success, 1 if any dataset failed.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile

# Keep in step with `DATASETS` in src/dataset.rs — the slugs are the contract
# between this script, the corpus folder layout, and `lc index --dataset`.
DATASETS = {
    "leetcode": "newfacade/LeetCodeDataset",
    "kodcode": "KodCode/KodCode-V1",
    "ms-python-q": "morganstanley/sft-python-q-problems",
    "deepseek-leetcode": "davidheineman/deepseek-leetcode",
    "leetcode-with-tests": "kr4t0n/leetcode-with-tests",
}

DEFAULT_DATA_DIR = os.path.expanduser("~/lc-data")


def default_out(data_dir, slug):
    """Where `lc` looks for a dataset when nothing overrides it.

    The original LeetCode corpus may sit in the data dir root for backwards
    compatibility, but a fresh download goes in its own folder like the rest —
    `Dataset::corpus_dir` prefers the subfolder when it exists.
    """
    return os.path.join(data_dir, slug)


def convert(repo_id, out_dir):
    """Snapshot `repo_id` and write every table in it as `.jsonl`."""
    from huggingface_hub import snapshot_download

    os.makedirs(out_dir, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="lc-hf-") as cache:
        local = snapshot_download(
            repo_id=repo_id,
            repo_type="dataset",
            local_dir=os.path.join(cache, "repo"),
        )
        written = 0
        for root, _dirs, files in os.walk(local):
            for name in sorted(files):
                source = os.path.join(root, name)
                lower = name.lower()
                if lower.endswith(".parquet"):
                    written += write_parquet(source, out_dir, local)
                elif lower.endswith((".jsonl", ".json")):
                    # Already readable by `lc index`; copy it across verbatim.
                    target = os.path.join(out_dir, flat_name(source, local, name))
                    shutil.copyfile(source, target)
                    written += 1
    return written


def flat_name(source, root, name):
    """`data/train-00000.parquet` -> `data__train-00000.parquet`.

    Flattened because `lc index` walks the folder recursively and only cares
    about file extensions, and a flat listing is far easier to reason about
    when a download half-fails.
    """
    relative = os.path.relpath(source, root)
    return relative.replace(os.sep, "__").replace("/", "__")


def write_parquet(source, out_dir, root):
    import pyarrow.parquet as pq

    target = os.path.join(
        out_dir, flat_name(source, root, os.path.basename(source))
    )
    target = os.path.splitext(target)[0] + ".jsonl"
    table = pq.read_table(source)
    with open(target, "w", encoding="utf-8") as handle:
        # Batched rather than `to_pylist()` on the whole table: KodCode is
        # 447k rows and materialising all of it at once is gigabytes.
        for batch in table.to_batches(max_chunksize=1000):
            for row in batch.to_pylist():
                handle.write(json.dumps(row, default=str) + "\n")
    return 1


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "datasets",
        nargs="*",
        metavar="DATASET",
        help="dataset slugs to fetch: " + ", ".join(sorted(DATASETS)),
    )
    parser.add_argument("--all", action="store_true", help="fetch every dataset")
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("LC_DATA_DIR", DEFAULT_DATA_DIR),
        help="corpus root; each dataset lands in <data-dir>/<slug>/ (default: %(default)s)",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="write to this folder instead of <data-dir>/<slug>/ (one dataset only)",
    )
    opts = parser.parse_args()

    wanted = sorted(DATASETS) if opts.all else list(opts.datasets)
    if not wanted:
        parser.error("name at least one dataset, or pass --all")
    unknown = [slug for slug in wanted if slug not in DATASETS]
    if unknown:
        parser.error(
            "unknown dataset(s) %s — expected one of %s"
            % (", ".join(unknown), ", ".join(sorted(DATASETS)))
        )
    if opts.out and len(wanted) > 1:
        parser.error("--out takes a single dataset")

    failed = []
    for slug in wanted:
        repo_id = DATASETS[slug]
        out_dir = opts.out or default_out(opts.data_dir, slug)
        print(f"{slug}: {repo_id} -> {out_dir}")
        try:
            written = convert(repo_id, out_dir)
        except Exception as err:  # noqa: BLE001 — report and keep going
            print(f"  failed: {err}", file=sys.stderr)
            failed.append(slug)
            continue
        if written == 0:
            print("  warning: no data files found in that repo", file=sys.stderr)
        else:
            print(f"  wrote {written} file(s) — now run: lc index --dataset {slug}")

    if failed:
        print(f"failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
