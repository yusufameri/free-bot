feature: pixel gate, armed (U6.7)
script: `bun packages/pixel-gate/src/cli.ts --repeat`
verdict: live-ui-verified (17 regions, 4 chrome and 13 content, in headless Chrome 155 against the real app and the committed export in one browser instance at nine viewports; the chrome statistic is 0 differing pixels over 22,230 chrome pixels, per viewport 0/0 at 360x800, 390x844, 430x932, 600x960 and 820x1180, 0/768 at 1024x768, 0/6118 at 1366x768, 0/7042 at 1440x900 and 0/8302 at 1920x1080, tolerance 0; both captures at every viewport are pixel-identical and two runs are RESULT: STABLE over 36 chrome region comparisons and nine totals; the vendored Geist face measures 243.62px against the absent family's 215.98px on both pages; no viewport scrolls horizontally; the four remaining content box deltas are declared in `docs/DESIGN-CONTRACT.md` with their pixels, and the gate exits non-zero on a chrome pixel, an undeclared moved box or a horizontal scroll)
artifact: `packages/verify/artifacts/pixel-gate/50c5e27/assert.txt`
commit: 50c5e275f7a7ecc08b0299361af1020b2c140443
date: 2026-10-19
