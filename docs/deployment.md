# Vercel deployment

Production: [codex-session-viewer.vercel.app](https://codex-session-viewer.vercel.app).
The site serves static HTML, JavaScript, CSS, WASM and four synthetic demo files.
There are no server functions, session uploads, analytics or application secrets.
Local files and the metadata cache remain in the browser. Browser permissions and
storage are separate for production, localhost and preview origins.

## Automatic publication

`.github/workflows/ci.yml` verifies pull requests without deployment credentials.
On a main push or manual **Verify** run on main, the deploy job waits for both
Rust platform jobs and the browser job. It downloads that run's `static-viewer`
artifact instead of rebuilding after testing. Main runs are serialized and the
deploy job skips a commit if main has advanced, preventing an obsolete queued
run or retry from rolling production back. Newer pull-request runs may cancel
obsolete verification.

`scripts/prepare-vercel.mjs` validates the artifact and creates a fresh Vercel
[Build Output API v3](https://vercel.com/docs/build-output-api/configuration)
package. It rejects symlinks, unexpected files and malformed WASM; the demo bytes
must match the checked-in synthetic fixtures. `scripts/deploy-vercel.mjs` uploads
that isolated package with pinned Vercel CLI 59.11.7 and `--prebuilt --prod`.
The repository, reports and local data are never sent as deployment source.

`scripts/check-deployment.mjs` then reads the public production origin without
authentication. Before fetching hashed assets, it allows a bounded interval for
both HTML entry paths to serve the new build after the production alias changes.
It then compares every file with the verified artifact and checks MIME types,
security/cache headers and a missing-WASM 404. Incorrect headers, redirects and
persistent byte mismatches remain failures. A failed check fails
the deployment job; it does not silently roll back an already-published site.
GitHub's job summary links to the verified production address.

The new Vercel project has no Git integration: GitHub Actions is the only automatic
publisher, avoiding duplicate unverified Vercel builds. Standard Vercel deployment
protection stays enabled for generated deployment URLs; the production domain is
public. No plan upgrade is required.

## Repository configuration

GitHub **Settings → Environments → production** allows only the `main` branch.
It contains:

| Kind     | Name                    | Value                                     |
| -------- | ----------------------- | ----------------------------------------- |
| Secret   | `VERCEL_TOKEN`          | Vercel token scoped to this project       |
| Variable | `VERCEL_ORG_ID`         | Vercel team ID                            |
| Variable | `VERCEL_PROJECT_ID`     | Vercel project ID                         |
| Variable | `VERCEL_PRODUCTION_URL` | `https://codex-session-viewer.vercel.app` |

The initial CI token expires in September 2027. Rotate it before expiry or after
suspected exposure: create a replacement scoped to this project, update the
environment secret, run **Verify** on main, then revoke the previous token. Use
Vercel's [token creation API](https://vercel.com/docs/rest-api/authentication/create-an-auth-token)
with `projectId` to limit access. Never put tokens in source, command arguments,
workflow YAML, screenshots or logs. The CLI accepts `VERCEL_TOKEN` from the
environment. GitHub stores the value as an encrypted environment secret.

For a fork, create your own Vercel project and set these four values. Keep the
production branch restriction and select a production domain belonging to that
project. No Vercel Git connection or remote build command is necessary.

## Manual deployment and recovery

Prefer **Actions → Verify → Run workflow → main** to rebuild, verify and publish.
For local publication of an already-verified artifact:

```sh
gh run download SUCCESSFUL_RUN_ID --name static-viewer --dir /tmp/viewer-artifact
export VERCEL_ORG_ID=your_team_id
export VERCEL_PROJECT_ID=your_project_id
export VERCEL_PRODUCTION_URL=https://your-project.vercel.app
npm run deploy:vercel -- /tmp/viewer-artifact
```

Use a fresh download directory and the checkout matching the artifact's commit,
so fixture validation compares against the right source. A local Vercel CLI login
is sufficient; CI requires `VERCEL_TOKEN`. The script creates and removes its own
temporary stage. It never deletes or alters the supplied artifact.

If publication or verification fails, inspect the GitHub deploy job and Vercel
deployment logs. Restore a known-good production deployment through Vercel's
dashboard rollback action, or revert the faulty source commit and let CI verify
and deploy the revert. Only promote deployments with successful verification.

## Serving behavior

HTML revalidates; hashed assets are immutable. WASM uses `application/wasm`.
The production CSP permits the same-origin workers and WASM engine, disallows
external connections and embedding, and permits inline styles required by layout.
There is no SPA fallback: a missing JavaScript/WASM file returns 404, not HTML.

Fresh deployments do not retain all old hashed assets. If a long-open tab needs
an asset from a retired build, the viewer reports the loading problem and offers
reload. Reload fetches the current HTML. User session files remain on disk and
the metadata cache stays associated with the stable production origin.
