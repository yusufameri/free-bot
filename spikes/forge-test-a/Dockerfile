# Derived spike image for forge test A. The base is the pinned sandbox image built from
# packages/sandbox/image/Dockerfile (U0.6), passed in as BASE_IMAGE so that recipe stays
# untouched and its pinned node digest label is inherited unchanged. Bun is added because the
# in-VM gateway uses pi-bridge's Bun.spawn transport; Pi itself still runs under the base
# image's node.
ARG BASE_IMAGE
FROM oven/bun:1 AS bun

FROM ${BASE_IMAGE}

USER root
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN mkdir -p /var/freebot-canary && pi --version

WORKDIR /work
CMD ["sleep", "infinity"]
