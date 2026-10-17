# THROWAWAY SPIKE IMAGE. Not production. See docs/browser-containment-spike.md.
#
# Debian bookworm-slim on arm64 plus exactly the tools the browser probes need:
# nftables (kernel-level default deny), chromium (the thing under test), curl
# (proxy liveness from inside), dnsutils (dig fallback evidence), fonts so
# chromium renders text into its screenshots. Build with --platform linux/arm64
# (run.sh does); TARGETPLATFORM is BuildKit's target platform, so the constant is
# only a fallback for non-BuildKit builds.
ARG TARGETPLATFORM=linux/arm64
FROM --platform=$TARGETPLATFORM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      curl \
      dnsutils \
      fonts-dejavu-core \
      fonts-liberation \
      nftables \
      python3 \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
COPY browser-probes.sh /browser-probes.sh
COPY probe-page.html /probe-page.html
RUN chmod 0755 /entrypoint.sh /browser-probes.sh

# The entrypoint applies the default-deny ruleset, then runs the browser probes
# as the container command. No proxy environment variables are set anywhere in
# the image: the denial has to come from the kernel, and the browser gets its
# proxy from command-line flags only.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/browser-probes.sh"]
