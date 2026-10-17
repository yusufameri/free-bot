# Pinned sandbox image: node 24.22.0 plus Pi 1.3.0, nothing else.
#
# The node base is pinned by digest, not by tag alone. `24.22.0-bookworm-slim` is the exact
# version tag pulled on 2026-10-16 (docker.io/library/node, digest
# sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5); the digest is what
# makes the build reproducible even if the tag is re-cut. Pi 1.3.0 requires node >= 22.19.0.
FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

LABEL org.freebot.sandbox.node-base-digest="sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5"

# Pi is installed from a tarball whose sha512 must match the integrity the registry published for
# 1.3.0 (recorded in docs/pi-rpc-spike.md), so the install is content-addressed, not just a
# version number. `test` fails the build if the version ever resolves to something else.
RUN set -eux; \
    tarball=$(npm pack @earendil-works/pi-coding-agent@1.3.0 --pack-destination /tmp --silent); \
    actual=$(node -e 'const {createHash}=require("node:crypto");const {readFileSync}=require("node:fs");console.log(createHash("sha512").update(readFileSync(process.argv[1])).digest("base64"))' "/tmp/$tarball"); \
    test "$actual" = "V/WoCjA2hQSe3QLWIUB24cTRdtEdeLiIzkDqU5RMXV6VWuD+KGZnzVBMhglwdnQTySkehZsjt8a3g6Jd2g4nnw=="; \
    npm install -g "/tmp/$tarball"; \
    rm -f "/tmp/$tarball"; \
    node --version \
 && pi --version \
 && test "$(pi --version)" = "1.3.0"

WORKDIR /workspace
CMD ["node", "--version"]
