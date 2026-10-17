# Derived image for the MVP smoke dry run (U0.11). The base is the pinned sandbox image built
# from packages/sandbox/image/Dockerfile (U0.6) and passed in as BASE_IMAGE, so that recipe and
# its pinned node digest label stay untouched. Bun is added because the in-VM supervisor and
# agent use pi-bridge's Bun.spawn transport; Pi itself still runs under the base image's node.
ARG BASE_IMAGE
FROM oven/bun:1 AS bun

FROM ${BASE_IMAGE}

USER root
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN pi --version

WORKDIR /work
CMD ["sleep", "infinity"]
