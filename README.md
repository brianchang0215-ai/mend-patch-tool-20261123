[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/brianchang0215-ai/mend-patch-tool-20261123/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/brianchang0215-ai/mend-patch-tool-20261123/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format: a Node 22 CLI (`main.ts`) that applies
unified diffs (including wrong line numbers), SEARCH/REPLACE blocks, V4A patches
and JSON text-editor tool calls to a tree of text files, exactly as the kit's
`SPEC.md` specifies — three-tier line matching, all-or-nothing writes, and the
specified exit codes and output.

Run it as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
Practice checks: `node check.ts <practice.json>` (100 checks).

Built for the make.fun bounty "Build mend, one patch tool for every AI edit format".
Licence: MIT.
