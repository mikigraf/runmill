# Releasing Runmill

Runmill is not published yet. This is the maintainer checklist for the first preview and every
release after it.

## One-time external setup

1. Claim the `runmill` package name on npm and enable account two-factor authentication.
2. In the npm package settings, configure GitHub Actions as the trusted publisher for
   `mikigraf/runmill`, workflow `publish.yml`, environment `npm`, with `npm publish` permission.
3. Create a protected GitHub environment named `npm` and require a maintainer approval.
4. Protect `main`, require CI and CODEOWNERS review, and enable private vulnerability reporting,
   secret scanning, push protection, and Dependabot security updates.
5. Set GitHub Pages to **GitHub Actions**. The pinned `pages.yml` workflow publishes `site/` after
   site or brand changes reach `main`; then set the repository homepage to the deployed URL.

The workflow uses npm 11.15.0 because npm trusted publishing requires a modern OIDC-capable CLI.
It receives `id-token: write`, never an npm token. npm creates provenance automatically for a
public package published from the public GitHub repository.

## Release procedure

1. Move the reviewed entries from `[Unreleased]` into a versioned changelog section.
2. Set the same version in `package.json`, then run:

   ```bash
   npm ci
   npm run check
   npm run package:check
   ```

3. Merge the release change through the protected branch.
4. Create and push a signed annotated tag named exactly `v<package-version>`.
5. Draft a GitHub Release from that tag. Mark preview releases as prereleases and review the
   generated notes before publishing it.
6. Publishing the GitHub Release starts `publish.yml`. Prereleases use the npm `next` tag; ordinary
   releases use `latest`.
7. Verify the installed artifact from an empty directory and confirm npm shows provenance.

The workflow refuses a tag that does not match `package.json`, reruns the full release gate, builds
and installs the exact tarball through `package:check`, and only then calls `npm publish`.

Do not publish from a laptop, add `NPM_TOKEN`, bypass the protected environment, or reuse a version.
