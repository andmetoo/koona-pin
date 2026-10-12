# The «ui» CI image (scripts/linux/images.mjs, plan A1): Playwright UI tests without Rust. The tag must be the
# Playwright of bun.lock (images.mjs fails when they differ): the browsers in /ms-playwright belong to it.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

COPY .bun-version /ci/
COPY scripts/linux/bun.sh /ci/scripts/linux/
# Noto Sans CJK for the language tests (Р-51); the user «dev» as in the other images (uid 1001 when free:
# the base has its own pwuser).
RUN export DEBIAN_FRONTEND=noninteractive \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends fonts-noto-cjk curl unzip xz-utils git ca-certificates > /dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && bash /ci/scripts/linux/bun.sh \
 && (id dev > /dev/null 2>&1 || useradd -m -u 1001 -U dev 2> /dev/null || useradd -m -U dev) \
 && rm -rf /ci
