feature: pi-rpc-spike
script: `bun spikes/pi-rpc/drive.ts`
verdict: spike-verified (39/39 assertions, keyless stub model, no test suite exists for it)
artifact: `packages/verify/artifacts/pi-rpc/e203adf/assert.txt`
commit: e203adffa3e8dd0ce047b42216d7414fd1838c15
date: 2026-10-17
legacy-count: the driver printed its tally as two lines, 'assertion frames ok=true:' and '39', and never wrote a RESULT line
