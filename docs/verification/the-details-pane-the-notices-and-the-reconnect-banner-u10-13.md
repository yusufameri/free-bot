feature: the details pane, the notices and the reconnect banner (U10.13)
script: `bun packages/verify/scripts/aside.ts`
verdict: live-ui-verified (111/111 checks over two launched apps and the driver's own relay). Two claims moved. The sidebar gained a `New group chat` control, and the transcript now renders a row only for the seven message types that own one; decisions, results, resolved approvals and status frames fold into the card or counter they belong to, so the driver compares the rendered seqs to the wire's row-bearing set and still requires the page's `lastSeq` to equal the log's tail. `Teach a task` left the prototype-data list because U6.8 ships it as the Skills page's action copy. The relay now keeps a write the socket could not take whole and sends the remainder on `drain`; before that, a 900 KB module script could lose its tail and the page its hooks.
artifact: `packages/verify/artifacts/aside/e18ce5f/assert.txt`
commit: e18ce5f996768d56942b65324dabf0cbf3bc2ff2
date: 2026-10-19
legacy-header: this run predates the writer's commit header and prints no full sha; the artifact directory's short sha and this row's commit are the only link
