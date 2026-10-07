# NP-093: the Linux checks run from Windows (scripts/linux/check.mjs). Ubuntu 22.04 has the oldest
# glibc of the contract (2.35), so the release binary built here runs on every distribution of it.
FROM ubuntu:22.04
ARG RUST_VERSION
ARG NODE_VERSION
ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    PATH=/opt/cargo/bin:/opt/node/bin:$PATH
# The packages of doc/testing.md «Linux», and what the copy and Node need.
COPY deps.sh /tmp/deps.sh
RUN bash /tmp/deps.sh && apt-get install -y --no-install-recommends ca-certificates xz-utils rsync \
    && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --component clippy --default-toolchain ${RUST_VERSION}
RUN mkdir /opt/node \
    && curl -sSf https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz | tar -xJ -C /opt/node --strip-components 1
# Not root: root ignores file permissions, and tests of read-only files and folders would pass for the
# wrong reason. New volumes take the owner of these folders.
RUN useradd -m -u 1000 dev && mkdir -p /work /out /opt/cargo/registry && chown -R dev /work /out /opt/cargo /opt/rustup
USER dev
WORKDIR /work
