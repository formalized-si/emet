"""Split a lean4export base into upload chunks for the kernel contract and LZ4-pack them.

usage: python3 pack_base.py <base.ndjson> <out_dir> [chunk_bytes]

Writes <out_dir>/chunk-NNNN.bin (`<idx> lz4\\n<lz4 block, size prepended>`) and
<out_dir>/manifest.json (base sha256, declaration count, chunk list). Chunks end on line
boundaries, as `load_base_chunk` requires. Packing uses the native helper
(`native/target/release/proof-courier-native --lz4`).
"""

import hashlib, json, pathlib, subprocess, sys, tempfile

KINDS = (b'{"axiom"', b'{"def"', b'{"thm"', b'{"opaque"', b'{"quot"', b'{"inductive"')


def main():
    base = pathlib.Path(sys.argv[1])
    out = pathlib.Path(sys.argv[2])
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 480_000
    packer = pathlib.Path(__file__).resolve().parents[1] / "tools/native/target/release/proof-courier-native"
    data = base.read_bytes()
    assert data.endswith(b"\n")
    out.mkdir(parents=True, exist_ok=True)
    chunks, start, idx = [], 0, 0
    while start < len(data):
        end = min(start + size, len(data))
        if end < len(data):
            end = data.rindex(b"\n", start, end) + 1
        with tempfile.NamedTemporaryFile(delete=False) as raw:
            raw.write(f"{idx}\n".encode() + data[start:end])
        name = f"chunk-{idx:04d}.bin"
        subprocess.run([str(packer), "--lz4", raw.name, str(out / name)], check=True)
        pathlib.Path(raw.name).unlink()
        chunks.append(name)
        start, idx = end, idx + 1
    decls = 0  # counted like the kernel: an inductive block counts its types, ctors and recs
    for line in data.split(b"\n"):
        if line.startswith(b'{"inductive"'):
            v = json.loads(line)["inductive"]
            decls += sum(len(v.get(k, [])) for k in ("types", "ctors", "recs"))
        elif line.startswith(KINDS):
            decls += 1
    manifest = {
        "base_sha256": hashlib.sha256(data).hexdigest(),
        "base_bytes": len(data),
        "base_decls": decls,
        "codec": "lz4",
        "chunks": chunks,
        "stored_bytes": sum((out / c).stat().st_size for c in chunks),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
