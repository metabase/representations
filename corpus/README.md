# Lint-parity corpus

The corpus checks the lint against what a real Metabase does, on many more folders than `examples/v1`. Each case is a folder plus Metabase's recorded answers on it. `bun test` lints every case and compares the result with those answers, offline, in a few seconds.

## Layout

- `base/`: the folder every case starts from. It is the transforms part of `examples/v1`: the Sample Postgres database, the transforms and their tests, tags, jobs and the Python library.
- `cases/*.yaml`: one case per file. Each holds:
  - `edits`: the files the case changes, with their new contents (`null` deletes a file).
  - `observation`: what Metabase did with the folder:
    - whether the import succeeded
    - for each transform, the tables Metabase reads
    - for each transform test, whether Metabase accepts it
  - `known`: `null` when the lint agrees with Metabase. Otherwise it holds the exact differences, and the test checks that the lint still gives exactly those. A fix, or a new difference, fails the test.
  - `origin`: where the case came from: a generator seed, or a review finding.

## Recording

Only `scripts/record-corpus.ts` writes cases, so every expected answer comes from Metabase, never from the lint. It needs:
- a Metabase with transforms enabled and read-write git sync
- a warehouse named `Sample Postgres`, as in `.github/workflows/import.yml`

```sh
# Record the review-finding cases of scripts/corpus-findings.ts.
bun run scripts/record-corpus.ts --url URL --api-key KEY --repo SYNC_REPO --findings

# Generate N cases (scripts/corpus-gen.ts) and keep the useful ones.
bun run scripts/record-corpus.ts --url URL --api-key KEY --repo SYNC_REPO --runs N --seed S

# Record every case again; exit 1 if Metabase now answers any of them differently.
bun run scripts/record-corpus.ts --url URL --api-key KEY --repo SYNC_REPO --check
```

`SYNC_REPO` is the git repository that Metabase's git sync reads. The recorder commits each case to a new branch there and imports that branch.

When a generated case disagrees, the recorder shrinks it to the fewest edits that still disagree. It writes the case with `known` set, once per SQL shape and kind of difference. A case that agrees is written only when it covers a tag or an answer that no case written earlier in the same run covers. Tags name SQL shapes, edits and spellings. A failed import compares no SQL, so it covers no tag.

A server error is recorded only when Metabase gives it twice in a row. Any other unexpected answer, such as a 403, stops the recording.

## After changing the lint

`known` is the lint's side of a case, so a change to the lint can change it without Metabase:

```sh
bun run scripts/refresh-known.ts
```

It updates `known` for each case, prints what changed, and never touches the recorded answers. Review the diff: a `known` that grows is a new disagreement.

The Import workflow runs `--check` against the latest Metabase build. If it fails, Metabase changed. Look at the case's new answers: either record the case again and fix the lint, or report the change to Metabase.
