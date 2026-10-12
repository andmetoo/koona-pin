# The «arch» CI image (scripts/linux/images.mjs, plan A1): koonapin-bin built from the AUR's PKGBUILD and
# checked with Arch's browsers (ci-runtime.sh). The base is rolling and its tag has no date: the image is
# rebuilt when its inputs change; to move to a newer Arch alone, change this date: 12 October 2026.
FROM archlinux:latest

COPY .bun-version /ci/
COPY scripts/linux/ci-runtime.sh scripts/linux/bun.sh /ci/scripts/linux/
RUN bash /ci/scripts/linux/ci-runtime.sh && rm -rf /ci
