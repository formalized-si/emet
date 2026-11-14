# The pinned Linux x86_64 toolchain for every ./verify.sh mode. It holds no project files:
# verify.sh mounts the checkout at /work and runs itself here when the host cannot (see verify.sh).
#   Node 22 and Python 3.13 (base image), Rust 1.98.0 + wasm32-unknown-unknown, cargo-near 0.22.0,
#   elan 4.2.4 + Lean 4.35.0. glibc 2.41, which near-sandbox 2.14.0 needs (>= 2.38).
# Build by hand:  docker build --platform linux/amd64 -t emet-verify - < Dockerfile
FROM node:22-trixie@sha256:c46850e69b4fab3c4f225aa36b777c8cc001d1cd5b2136e1ea024796f6d3bbbb
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo ELAN_HOME=/opt/elan \
    PATH=/opt/cargo/bin:/opt/elan/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN set -eux; cd /tmp; \
    curl -fsSLO https://static.rust-lang.org/rustup/archive/1.29.0/x86_64-unknown-linux-gnu/rustup-init; \
    echo "4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10  rustup-init" | sha256sum -c -; \
    chmod +x rustup-init; \
    ./rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.98.0 --target wasm32-unknown-unknown; \
    rustc -vV | grep -qx 'commit-hash: 88d9e12ae178fab0fb5cc050a94da85685d449ea'; \
    curl -fsSLO https://github.com/near/cargo-near/releases/download/cargo-near-v0.22.0/cargo-near-x86_64-unknown-linux-gnu.tar.gz; \
    echo "9429064e30a427e96523f539cb255f3688d2345e5000d7d4e4873a8247247d1a  cargo-near-x86_64-unknown-linux-gnu.tar.gz" | sha256sum -c -; \
    tar -xzf cargo-near-x86_64-unknown-linux-gnu.tar.gz; \
    install -m 755 cargo-near-x86_64-unknown-linux-gnu/cargo-near /opt/cargo/bin/cargo-near; \
    cargo near --version | grep -q 0.22.0; \
    curl -fsSLO https://github.com/leanprover/elan/releases/download/v4.2.4/elan-x86_64-unknown-linux-gnu.tar.gz; \
    echo "42b94d4244e8353142c456ec0e4ca6528fd898a6c604d4059f494e706e431f63  elan-x86_64-unknown-linux-gnu.tar.gz" | sha256sum -c -; \
    tar -xzf elan-x86_64-unknown-linux-gnu.tar.gz; \
    ./elan-init -y --no-modify-path --default-toolchain leanprover/lean4:v4.35.0; \
    lean --version | grep -q 'version 4.35.0, x86_64-unknown-linux-gnu, commit eb6cafb7290e8bd5f2937522d8d804f58f02bafc'; \
    rm -rf /tmp/*; chmod -R a+rX /opt
WORKDIR /work
