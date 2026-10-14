# Development

## Build and preview

Use Node.js 22+ and the pinned TypeScript compiler. Python 3 serves local pages.

```sh
npm ci --ignore-scripts
npm run check
npm run examples:build
npm run examples:serve
```

Open http://localhost:8401/ for documentation and live tutorials. Generated output
is in `.example-build/site/`. See [website publication](examples.md) for Pages and Gists.

For diagnostic pages:

```sh
python3 demo/generate-tiles.py
npm run demo
npm run e2e
npm run e2e -- --webgpu
npm run e2e -- --basic
```

Open http://localhost:8400/demo/. Browser checks require an installed Chromium-family
browser; video fixture generation additionally requires ffmpeg. See
[testing and fixtures](status.md#running-the-checks).

## Repository

| Directory | Contents |
| --- | --- |
| `src/` | Library source |
| `test/`, `type-tests/` | Unit, integration, distribution and consumer-type tests |
| `docs/` | Guides, tutorial prose, contracts and benchmark records |
| `examples/` | Live tutorial JavaScript, site styling and browser helpers |
| `demo/` | Diagnostic pages, fixture generators and GPU regression scenarios |
| `scripts/` | Builds, declarations and publication |

Generated builds, screenshots, caches and downloaded provider tiles are not source
files. Preserve diagnostic fixtures and their notices; they are part of the tests.

## Releases

Every push to `main` runs build, type and unit checks. A package version change
publishes the tested archive to GitHub Packages and creates a GitHub Release at
the tested commit. A later build-fix push also releases a version that has no
release tag yet. Once its tag exists, documentation-only pushes redeploy the
website without creating another package release.

```sh
npm version prerelease --preid=alpha --no-git-tag-version
```

Update the public `version` export and changelog with the manifest, commit, then
push `main`. Prereleases use `next`; stable versions use `latest`. Existing published
versions are never overwritten. The workflow retains package build artifacts for
14 days and attaches the archive to the release.

If a workflow fails, fix the cause before retrying. An incomplete GitHub release
requires explicit cleanup in GitHub; the workflow refuses to overwrite it silently.
