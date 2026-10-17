# Spike-only sandbox image for the tunnel check. The branch ships no packages/sandbox/image yet;
# when U0.6 lands, that recipe supersedes this one.
#
# Both runtimes are load-bearing: Pi's bundle imports undici at startup and crashes under bun
# (Bun v1.2.5, TypeError: webidl.util.markAsUncloneable), while the sandbox agent uses bun for
# pi-bridge's Bun.spawn transport. The repo itself is bind-mounted at /work, so nothing here
# bakes in source or node_modules.
FROM oven/bun:1 AS bun

FROM node:24.22.0-bookworm-slim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /work
CMD ["sleep", "infinity"]
