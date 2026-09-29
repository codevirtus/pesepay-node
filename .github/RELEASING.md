# Releasing

Publishing is a tag push. Everything else is automated, except a one-time setup
that needs an npm account with maintainer rights on `pesepay`.

## One-time setup: Trusted Publishing and the `npm-publish` environment

The release workflow authenticates with a short-lived OIDC token. Do not add an
`NPM_TOKEN` to this repository.

On npmjs.com, open the `pesepay` package → Settings → Trusted Publisher:

| field | value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `codevirtus` |
| Repository | `pesepay-node` |
| Workflow filename | `release.yml` |
| Environment | `npm-publish` |

Then, in this repository → Settings → Environments, create an environment named
**`npm-publish`** and add the maintainers as required reviewers. Each publish
then waits for a maintainer's approval.

If publishing fails with `ENEEDAUTH`, check that the environment name matches
on both sides.

Trusted Publishing requires a public package and repository, and npm 11.5.1 or
newer (the workflow installs it). Provenance comes from
`publishConfig.provenance` in `package.json`, so don't add a `--provenance`
flag.

## Cutting a release

1. Merge everything, and make sure `npm run verify` passes.
2. Write the `CHANGELOG.md` section for the version, dated the day you tag it.
   It becomes the GitHub release notes; the release fails if the section is
   missing or empty.
3. Bump `version` in `package.json` (`npm version --no-git-tag-version <v>`).
4. Commit, and push to `main`.
5. Tag and push:

   ```shell
   git tag -a v2.0.0 -m 'v2.0.0'
   git push origin v2.0.0
   ```

The tag push runs `release.yml`. It checks that the tag matches `package.json`,
runs `npm run verify` and the package check, waits for approval, publishes to
npm, and creates the GitHub release.

A version with a hyphen, such as `2.0.0-rc.1`, publishes under the `next`
dist-tag as a prerelease and leaves `latest` unchanged.

## After publishing

```shell
npm view pesepay dist-tags        # latest: 2.0.0
npm view pesepay@1 version        # 1.0.4, still installable
npm audit signatures              # provenance verifies
```
