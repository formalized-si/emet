#!/usr/bin/env python3
"""Let near-sandbox start on Linux x86_64 with a C library older than 2.38, without Docker.

usage: newer_glibc.py <directory that holds the near-sandbox binary>

The binary needs glibc >= 2.38 and a matching libstdc++ (Debian 12 has 2.36, Ubuntu 22.04 has 2.35).
This unpacks Debian 13's libc6, libgcc-s1 and libstdc++6 into <directory>/glibc and replaces
near-sandbox with a two-line script that starts the real binary (near-sandbox.bin) through that
loader. Nothing outside <directory> is touched. The three packages come from snapshot.debian.org
and are checked against the sha256 values below.
"""

import hashlib
import io
import os
import sys
import tarfile
import urllib.request

SNAPSHOT = "https://snapshot.debian.org/archive/debian/"
PACKAGES = [
    (
        "20250805T202250Z/pool/main/g/glibc/libc6_2.41-12_amd64.deb",
        "6cff801097cd0eb2126b60e533f37afdc78456efacdf2bfae62877f00c795d0b",
    ),
    (
        "20250315T204837Z/pool/main/g/gcc-14/libgcc-s1_14.2.0-19_amd64.deb",
        "3c71917b490d1a17aed43196a2787a256ecf060526cdb20216a74bedc061b150",
    ),
    (
        "20250315T204837Z/pool/main/g/gcc-14/libstdc++6_14.2.0-19_amd64.deb",
        "ab1fa05837aa7a92aae748fd07a18a35f7d18bb4a71c4724fe2bbf0e32089de0",
    ),
]
LIBDIR = "/lib/x86_64-linux-gnu"


def unpack(deb, out):
    """A .deb is an ar archive: 60-byte member headers, data padded to an even length."""
    at = 8
    while at < len(deb):
        name, size = deb[at : at + 16].decode().strip(), int(deb[at + 48 : at + 58])
        at += 60
        if name.startswith("data.tar"):
            with tarfile.open(fileobj=io.BytesIO(deb[at : at + size])) as tar:
                for member in tar:
                    if not os.path.dirname(member.name).endswith(LIBDIR):
                        continue
                    target = os.path.join(out, os.path.basename(member.name))
                    if member.isfile():
                        with open(target, "wb") as f:
                            f.write(tar.extractfile(member).read())
                        os.chmod(target, 0o755)
                    elif member.issym() and not os.path.lexists(target):
                        os.symlink(os.path.basename(member.linkname), target)
        at += size + size % 2


def main():
    sandbox = os.path.abspath(sys.argv[1])
    lib, real, entry = (os.path.join(sandbox, n) for n in ("glibc", "near-sandbox.bin", "near-sandbox"))
    if not os.path.exists(os.path.join(lib, "libstdc++.so.6")):
        os.makedirs(lib, exist_ok=True)
        for path, want in PACKAGES:
            deb = urllib.request.urlopen(SNAPSHOT + path, timeout=120).read()
            if hashlib.sha256(deb).hexdigest() != want:
                raise SystemExit(f"{path}: sha256 differs from the pinned value")
            unpack(deb, lib)
    if not os.path.exists(real):
        os.rename(entry, real)
    with open(entry, "w") as f:
        f.write(f'#!/bin/sh\nexec "{lib}/ld-linux-x86-64.so.2" --library-path "{lib}" "{real}" "$@"\n')
    os.chmod(entry, 0o755)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(f"tools/newer_glibc.py: {error}")
