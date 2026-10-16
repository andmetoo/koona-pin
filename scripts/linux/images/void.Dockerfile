# The «void» CI image (scripts/linux/images.mjs, plan A1): where the release binaries are compiled, once, by
# `build-linux-packages.mjs --stage compile`, and where the Rust and web tests run. Void's glibc is no older
# than the matrix's floor; scripts/linux/check-glibc.sh fails the build when a newer base raises it.
# The base is rolling: a newer date here moves it (and rebuilds the image, the tag hashes this file).
FROM ghcr.io/void-linux/void-glibc:20261001R1

# xbps updates itself before anything else; the scripts are bash, the base has only dash.
RUN xbps-install -Syu xbps && xbps-install -yu && xbps-install -y bash

COPY .bun-version rust-toolchain.toml /ci/
COPY scripts/linux/deps.sh scripts/linux/bun.sh /ci/scripts/linux/

# The Tauri prerequisites (deps.sh), what actions/checkout and the stages need besides them: git, strip and
# objdump (binutils, check-glibc.sh), mksquashfs for the AppImage, useradd (shadow) and su (util-linux),
# which the minimal base may lack, diff (diffutils: the «test» job compares src/bindings), find (findutils:
# linuxdeploy's GTK plugin for the AppImage), tar and compression tools for the Rust cache; Bun of .bun-version.
RUN bash /ci/scripts/linux/deps.sh \
 && xbps-install -y git tar gzip zstd xz unzip ca-certificates binutils squashfs-tools shadow util-linux diffutils findutils \
 && bash /ci/scripts/linux/bun.sh \
 && rm -rf /var/cache/xbps/*

# Rust of rust-toolchain.toml outside any home, writable by «dev» (the jobs' rust-cache restores into it).
# tauri-driver 2.1.0: the WebDriver server of the native tests on WebKitGTK (NP-095, Р-57), handed to the
# package jobs, which have no compiler, as an artifact of «build».
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN rust=$(tr -d '\r' < /ci/rust-toolchain.toml | sed -n 's/^channel *= *"\(.*\)"/\1/p') \
 && curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "$rust" \
 && cargo install tauri-driver --version 2.1.0 --locked --root /usr/local --quiet \
 && rm -rf "$CARGO_HOME/registry" "$CARGO_HOME/git" /usr/local/.crates.toml /usr/local/.crates2.json

# The user «dev» runs the builds and tests. Tauri's AppImage tools ready in its cache (the URLs of
# tauri-bundler's linuxdeploy.rs, @tauri-apps/cli 2.12): no download per build; a newer CLI that wants
# others fetches them itself. A container has no FUSE: AppImages (linuxdeploy) run unpacked.
ENV APPIMAGE_EXTRACT_AND_RUN=1
RUN useradd -m -u 1001 -U dev \
 && tools=/home/dev/.cache/tauri && mkdir -p "$tools" \
 && curl -sSfL -o "$tools/AppRun-x86_64" https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64 \
 && curl -sSfL -o "$tools/linuxdeploy-07333c6-x86_64.AppImage" https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy-07333c6/linuxdeploy-x86_64.AppImage \
 && curl -sSfL -o "$tools/linuxdeploy-plugin-appimage.AppImage" https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage \
 && chmod +x "$tools"/* \
 && mkdir -p /home/dev/.bun/install/cache \
 && chown -R dev:dev /home/dev "$RUSTUP_HOME" "$CARGO_HOME" \
 && rm -rf /ci
