# The exported prototype, frozen

Four files, byte-identical to the OpenDesign export copied into the coordinator's store at
`~/.opencode/orchestrate/freebot/design/`. They are a frozen artifact, not source: nothing in the
repo reads them at runtime, and `biome.json` excludes this directory so the formatter leaves them
alone.

| File | sha256 |
| --- | --- |
| `DESIGN-HANDOFF.md` | `9f20789998ed6a86f00749c456992f802e6c462f3bbf3df87b7b67d28ec6a2a8` |
| `DESIGN-MANIFEST.json` | `bf403f0566b845f0f7862d87e463253cb6500e4c08983ad68711d322a1c6fc48` |
| `freebot-prototype-v1.html` | `e310f44e4c4e605085a5fb8893d0fc9fd663921e60d76490ae64cea1351e89ba` |
| `freebot-prototype.html` | `e5f2555a996feec468096847b7f2be97fe5834808df9dc42c1549f4281638ef1` |

## Provenance

The archive `~/Downloads/FreeBot-UX-Prototype.zip` (OpenDesign handoff
`84c6b185-666c-4f59-8459-59b204c43d01`) extracted and copied to the store's `design/`, then copied
here unchanged. Plan Part 10 is the contract these files answer to.

## Role

`docs/DESIGN-CONTRACT.md` records which file governs which surface and why. The shell's tokens,
geometry and breakpoints come from `freebot-prototype.html`; the handoff names
`freebot-prototype-v1.html` as its entry file, and that difference is reconciled there. The nine
viewport widths come from `DESIGN-MANIFEST.json`'s `responsiveViewports`.

`packages/verify/scripts/design-contract.ts` opens `freebot-prototype.html` in the same headless
browser, at the same viewport, as the app and measures both. It serves the export with one byte
change, the initial screen, so the export boots into its app screen instead of its welcome screen.
