# The «fedora» CI image (scripts/linux/images.mjs, plan A1): the rpm stage of build-linux-packages.mjs, rpmlint
# and the .rpm installed with Fedora's browsers (ci-runtime.sh).
FROM fedora:44

COPY .bun-version /ci/
COPY scripts/linux/ci-runtime.sh scripts/linux/bun.sh /ci/scripts/linux/
RUN bash /ci/scripts/linux/ci-runtime.sh && rm -rf /ci
