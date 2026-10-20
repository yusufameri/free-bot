feature: browser containment spike
script: `bash spikes/browser-containment/run.sh`
verdict: spike-verified (7/7 browser probes inside the default-deny netns, UDP attributed by port bucket)
artifact: `packages/verify/artifacts/containment-browser/27cf9de/probes.txt`
commit: 27cf9dee665547356177d8c0ce3d39b2c8f623b9
date: 2026-10-17
