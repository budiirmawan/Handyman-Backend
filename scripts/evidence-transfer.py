#!/usr/bin/env python3
"""Offline operator tool; requires stopped writers and a trusted, private directory.
No database access, deletion, overwrites, archive extraction, or network calls.
"""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import shutil

KEY = re.compile(r"(?:evidence|reports)/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")


def safe_root(value):
    root = Path(value).absolute()
    if root.is_symlink() or any(p.is_symlink() for p in root.parents):
        raise ValueError("symlink in root path")
    if not root.is_dir():
        raise ValueError("root must be an existing directory")
    return root.resolve(strict=True)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inventory(root):
    entries = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError("symlinks are not transferable")
        for name in files:
            path = Path(directory) / name
            key = path.relative_to(root).as_posix()
            if not KEY.fullmatch(key) or not path.is_file():
                raise ValueError(f"unmanaged file requires operator review: {key}")
            entries[key] = {'size': path.stat().st_size, 'sha256': digest(path)}
    return dict(sorted(entries.items()))


def load_manifest(path):
    data = json.loads(Path(path).read_text())
    if data.get('version') != 1 or not isinstance(data.get('files'), dict):
        raise ValueError('unsupported manifest')
    for key, info in data['files'].items():
        if not KEY.fullmatch(key) or not re.fullmatch('[0-9a-f]{64}', info['sha256']) or not isinstance(info['size'], int) or info['size'] < 0:
            raise ValueError('unsafe manifest entry')
    return data['files']


def verify(root, expected):
    actual = inventory(root)
    if actual != expected:
        missing = len(expected.keys() - actual.keys())
        extra = len(actual.keys() - expected.keys())
        changed = sum(actual[k] != expected[k] for k in actual.keys() & expected.keys())
        raise ValueError(f'integrity failure: missing={missing}, extra={extra}, changed={changed}')
    return actual


def references(path, actual):
    count = 0
    with Path(path).open(newline='') as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != ['key', 'sha256', 'size']:
            raise ValueError('reference CSV headers must be key,sha256,size')
        for row in reader:
            key = row['key']
            if not KEY.fullmatch(key):
                raise ValueError('non-managed reference requires operator resolution')
            if key not in actual:
                raise ValueError(f'missing referenced file: {key}')
            info = actual[key]
            if row['sha256'] and row['sha256'].lower() != info['sha256']:
                raise ValueError(f'database checksum mismatch: {key}')
            if row['size'] and int(row['size']) != info['size']:
                raise ValueError(f'database size mismatch: {key}')
            count += 1
    print(f'Validated {count} metadata references; {len(actual)} files (unreferenced files retained).')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['inventory', 'verify', 'copy'])
    parser.add_argument('root')
    parser.add_argument('manifest')
    parser.add_argument('--destination', help='copy only: an existing EMPTY directory')
    parser.add_argument('--references', help='verify only: CSV exported from the same frozen database')
    args = parser.parse_args()
    root = safe_root(args.root)
    if args.command == 'inventory':
        manifest = Path(args.manifest).resolve()
        if manifest == root or root in manifest.parents:
            raise ValueError('manifest must be outside storage root')
        data = {'version': 1, 'files': inventory(root)}
        # Refuse overwrite; backups must use unique snapshot names.
        with manifest.open('x') as stream:
            json.dump(data, stream, indent=2)
            stream.write('\n')
        print(f'Inventoried {len(data["files"])} files.')
        return
    expected = load_manifest(args.manifest)
    actual = verify(root, expected)
    if args.references:
        references(args.references, actual)
    if args.command == 'copy':
        if not args.destination:
            raise ValueError('--destination is required')
        destination = safe_root(args.destination)
        if destination == root or root in destination.parents or destination in root.parents:
            raise ValueError('source and destination must not overlap')
        if any(destination.iterdir()):
            raise ValueError('destination must be empty; no overwrite allowed')
        for key in expected:
            target = destination / key
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            # Exclusive create plus validated keys; operator must prevent concurrent access.
            with (root / key).open('rb') as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o600)
        verify(destination, expected)
        verify(root, expected)
    print(f'PASS: {len(expected)} files verified.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SystemExit(f'FAIL: {error}')
