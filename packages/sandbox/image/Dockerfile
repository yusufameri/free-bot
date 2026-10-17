# Pinned sandbox image: node 24.22.0 plus Pi 1.3.0, nothing else.
#
# The node base is pinned by digest, not by tag alone. `24.22.0-bookworm-slim` is the exact
# version tag pulled on 2026-10-16 (docker.io/library/node, digest
# sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5); the digest is what
# makes the build reproducible even if the tag is re-cut. Pi 1.3.0 requires node >= 22.19.0.
FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

LABEL org.freebot.sandbox.node-base-digest="sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5"

# `test` fails the build if the pinned range ever resolves to a different pi.
RUN npm install -g @earendil-works/pi-coding-agent@1.3.0 \
 && node --version \
 && pi --version \
 && test "$(pi --version)" = "1.3.0"

WORKDIR /workspace
CMD ["node", "--version"]
