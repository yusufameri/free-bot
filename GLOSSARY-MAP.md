# Glossary map

This repo has one glossary. `GLOSSARY.md` is it, and it is the first place to look up a project word.
The map below says where each other document's vocabulary comes from, so a reader knows when a word
means what the glossary says and when a document is naming something of its own.

| Vocabulary | Where it lives | What it covers |
| --- | --- | --- |
| Product words | `GLOSSARY.md` | The one meaning for every word this project shares, with the file each was read from. |
| Product behavior and copy | `UX.md`, its vocabulary table | Page inventory, flows, and the copy a person reads. Governs behavior and copy semantics, not visuals. |
| Visual contract | `docs/DESIGN-CONTRACT.md`, `design/prototype-84c6b185/DESIGN-MANIFEST.json` | Token names, shell geometry, breakpoints, and the nine-viewport matrix. The export governs visuals; `UX.md` governs behavior. |
| Program words | `preferences.md`, plan Part 9 | `unit`, `track`, `brief`, `drain`, `landing`, `frontier`, `worker`, `coordinator`, human `gate`. Private to running the project, not to the product. `GLOSSARY.md` spells out each overload. |
| Model flags | `packages/providers/src/flags.ts` | The `toolCalling` / `streaming` / `structuredOutput` / `contextWindow` names and what each observation means. |
| Deny codes | `packages/review/src/policy.ts` | The ten gate denial codes and the fail-closed rule each stands for. |
| Event kinds | `packages/protocol/src/events.ts` | The `EVENT_PAYLOADS` taxonomy, one kind per fact the control plane can put in the stream. |
| Verdicts | `docs/VERIFICATION.md` | The `live-ui-verified` / `unit-test-verified` / `type-check-only` / `spike-verified` labels. |
| Operator words | `docs/RUNNING.md` | The flags, the boot line, and the vault as a person meets them. |

A word defined in a document's own table and absent from `GLOSSARY.md` is that document's word. When
two of them disagree, the more specific source wins: the code over a document, the export over
`UX.md` on a visual question, and `UX.md` over the export on a behavior question.
