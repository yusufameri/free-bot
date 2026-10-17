# THROWAWAY SPIKE IMAGE. Not production. See docs/containment-spike.md.
#
# Debian bookworm-slim on arm64 plus exactly the tools the probes need:
# nftables (kernel-level default deny), curl (HTTP through the proxy), dnsutils
# (dig), python3 (a UDP send with a wait for a reply), netcat-openbsd (raw TCP).
# Build with --platform linux/arm64 (run.sh does); TARGETPLATFORM is BuildKit's
# target platform, so the constant is only a fallback for non-BuildKit builds.
ARG TARGETPLATFORM=linux/arm64
FROM --platform=$TARGETPLATFORM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      dnsutils \
      netcat-openbsd \
      nftables \
      python3 \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
COPY probes.sh /probes.sh
RUN chmod 0755 /entrypoint.sh /probes.sh

# The entrypoint applies the default-deny ruleset, then runs the probes as the
# container command. No proxy environment variables are set anywhere in the
# image: the denial has to come from the kernel, not from HTTP_PROXY.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/probes.sh"]
