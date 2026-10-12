# The «debian» CI image (scripts/linux/images.mjs, plan A1): the deb stage of build-linux-packages.mjs and
# Debian's package checks (ci-runtime.sh), the package jobs' runtime, and the WebKitGTK interface check
# (ci-webkitgtk.sh setup). Debian 13 is the matrix's glibc floor.
FROM debian:13

# The Playwright of bun.lock (images.mjs fails when they differ): Chrome for Testing's system libraries.
ENV PLAYWRIGHT_VERSION=1.63.0

COPY .bun-version /ci/
COPY scripts/linux/ci-runtime.sh scripts/linux/ci-webkitgtk.sh scripts/linux/bun.sh /ci/scripts/linux/
RUN bash /ci/scripts/linux/ci-runtime.sh \
 && bash /ci/scripts/linux/ci-webkitgtk.sh setup \
 && rm -rf /ci
