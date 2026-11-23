# makefun-mend-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Fizal127/makefun-mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Fizal127/makefun-mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it reads a patch in any of
four formats — unified diffs (even with wrong line numbers), SEARCH/REPLACE
blocks, V4A patches, and JSON text-editor tool calls — finds the lines each
edit names at the first of three matching tiers (exact, trailing whitespace,
then indentation too), and writes every change or none. `SPEC.md` is the
whole contract.

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22, standard library alone, nothing to install. `PATCH` is the path of
the patch file; when it is absent or `-`, the patch is read from standard
input. The working directory is the root of the tree of text files.

Options:

- `--format=NAME` — read the patch in one format: `unified`,
  `search-replace`, `v4a`, `json`, or `auto` (the default, which detects it).
- `--check` — do everything but write: same output and exit code, no file
  is created, changed or deleted.
- `--strict` — match lines exactly (tier 0 only).
- `--` — ends the options; every argument after it is positional.

## Output and exit codes

- Exit 0: one line per changed path (`A` added, `D` deleted, `M` modified,
  `R old -> new` moved), then `ok: <n> files` (or `ok: 1 file`).
- Exit 1: one `error: <code> <path>` line per failed edit, in the patch's
  order, then `failed: <k> of <n> edits`. Nothing is written.
- Exit 2: exactly one line — `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.

## Supported edit formats

- **Unified diff** (`--format=unified`): `diff --git` sections and bare
  `---`/`+++` pairs; creations, deletions and moves (including `rename
  from`/`rename to`); hunks matched nearest to their header's line number,
  with `\ No newline at end of file` honoured.
- **SEARCH/REPLACE** (`--format=search-replace`): `<<<<<<< SEARCH` blocks
  with the path on the nearest non-blank, non-fence line above; a block
  with no path reuses the previous block's path; an empty old side creates
  the file; a match at more than one place is `ambiguous`.
- **V4A** (`--format=v4a`): `*** Begin Patch` / `*** End Patch` with `Add
  File`, `Delete File` and `Update File` sections, `@@` anchors, `*** Move
  to:` and `*** End of File` chunks, applied with a cursor that walks the
  file in order.
- **JSON** (`--format=json`): one array of edit objects, or JSON Lines —
  `create`, `str_replace` and `insert` commands.

## Matching tiers

Old lines are found at the first tier where they occur at least once:
tier 0 (every line equal), tier 1 (trailing spaces and tabs ignored), tier 2
(leading and trailing spaces and tabs ignored). At tier 2, new lines are
re-indented from the old lines' indentation to the file's. Context lines are
always written as the file's own matched lines. CRLF files keep CRLF, and a
file's final line break is kept exactly as it was, except where a unified
hunk's `\` line says otherwise.

## Check it

```sh
node check.ts <kit>/program/generator/practice.json
```

Runs `main.ts` on the kit's 100 public practice checks and prints the
practice score.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bp35q4sh&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
