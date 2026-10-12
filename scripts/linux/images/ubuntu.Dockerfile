# The «ubuntu» CI image (scripts/linux/images.mjs, plan A1): the .deb installed on the newest Ubuntu, and the
# WebKitGTK interface check (ci-runtime.sh, ci-webkitgtk.sh setup).
FROM ubuntu:26.04

COPY .bun-version /ci/
COPY scripts/linux/ci-runtime.sh scripts/linux/ci-webkitgtk.sh scripts/linux/bun.sh /ci/scripts/linux/
RUN bash /ci/scripts/linux/ci-runtime.sh \
 && bash /ci/scripts/linux/ci-webkitgtk.sh setup \
 && rm -rf /ci
