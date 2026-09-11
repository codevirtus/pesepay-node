# Releasing

Publishing is a tag push. Everything else is automation, except two one-time
steps that need an npm account with maintainer rights on `pesepay`
(`codevirtus`, `charlescoder` or `deanmaponga`, who published 1.0.4).

## One-time setup

### 1. The `v1` dist-tag — before 2.0.0 goes out

```shell
npm dist-tag add pesepay@1.0.4 v1
npm dist-tag ls pesepay          # expect: latest: 1.0.4, v1: 1.0.4
```

1.0.4 stays installable either way — publishing 2.0.0 moves `latest` and does
not touch it — but `MIGRATION.md` tells 1.x users to install `pesepay@v1`, and
that instruction has to be true the moment the document reaches the registry.
`release.yml` refuses to publish `latest` until `dist-tags.v1` reads `1.0.4`.

### 2. Trusted Publishing, and the `npm-publish` environment

There is no `NPM_TOKEN` anywhere in this repository, and there should never be
one. The release workflow authenticates with a short-lived OIDC token.

On npmjs.com, under the `pesepay` package → Settings → Trusted Publisher:

| field | value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `codevirtus` |
| Repository | `pesepay-node` |
| Workflow filename | `release.yml` |
| Environment | `npm-publish` |

Then, in this repository → Settings → Environments, create an environment named
**`npm-publish`** — the same string — and add the maintainers as required
reviewers. Publishing then pauses for a human approval.

A mismatch between those two environment names is the usual cause of `ENEEDAUTH`
at publish time; the workflow is otherwise unauthenticated by design.

Trusted Publishing also requires the package and the repository to be public,
and npm 11.5.1 or newer — the workflow installs it. Provenance comes from
`publishConfig.provenance` in `package.json`; do not add a `--provenance` flag.

## Cutting a release

1. Land everything, with `npm run verify` green.
2. Write the `CHANGELOG.md` section for the version. It becomes the GitHub
   release body verbatim — `scripts/release-notes.mts` extracts it, and the
   release fails rather than publishing empty notes.
3. Bump `version` in `package.json` (`npm version --no-git-tag-version <v>`).
4. Commit, and push to `main`.
5. Tag and push:

   ```shell
   git tag -a v2.0.0 -m 'v2.0.0'
   git push origin v2.0.0
   ```

The tag push runs `release.yml`: it checks the tag against `package.json`,
checks the `v1` dist-tag, runs `npm run verify` and the tarball check, waits for
the environment approval, publishes, and creates the GitHub release.

A version containing a hyphen — `2.0.0-rc.0` — publishes under the `next`
dist-tag and is marked a prerelease. `latest` does not move. Installing an RC
into one real consumer application before cutting `2.0.0` is cheap insurance for
a rewrite of a payments SDK.

## Afterwards

```shell
npm view pesepay dist-tags        # latest: 2.0.0, v1: 1.0.4
npm audit signatures              # provenance verifies
npm install pesepay@1.0.4         # still resolves, unchanged
```
