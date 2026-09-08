import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareVercel } from './prepare-vercel.mjs';
import { checkDeployment } from './check-deployment.mjs';

const required = ['VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'VERCEL_PRODUCTION_URL'];
if (process.env.CI) required.push('VERCEL_TOKEN');
for (const name of required) {
  if (!process.env[name]) throw new Error(`Set ${name} before deploying.`);
}
const productionUrl = new URL(process.env.VERCEL_PRODUCTION_URL);
if (
  productionUrl.protocol !== 'https:' ||
  productionUrl.username ||
  productionUrl.password ||
  productionUrl.pathname !== '/' ||
  productionUrl.search ||
  productionUrl.hash
) {
  throw new Error('VERCEL_PRODUCTION_URL must be a plain HTTPS origin.');
}

// Stage outside the checkout: Vercel receives only allowlisted static output,
// never the source tree, ignored local sessions, reports, or credentials.
const temporary = await mkdtemp(join(tmpdir(), 'codex-viewer-vercel-'));
try {
  const stage = join(temporary, 'site');
  await prepareVercel(resolve(process.argv[2] ?? 'dist'), stage);
  await writeFile(
    join(stage, '.vercel/project.json'),
    JSON.stringify({
      orgId: process.env.VERCEL_ORG_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    }),
  );
  await new Promise((resolve, reject) => {
    // CLI accepts VERCEL_TOKEN from the environment; keep it out of argv/logs.
    const child = spawn(
      'npx',
      ['--yes', 'vercel@59.11.7', 'deploy', '--prebuilt', '--prod', '--yes', '--cwd', stage],
      {
        stdio: 'inherit',
        env: { ...process.env, VERCEL_TELEMETRY_DISABLED: '1' },
      },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Vercel deployment exited with ${code}.`)),
    );
  });
  const result = await checkDeployment(productionUrl.origin, join(stage, '.vercel/output/static'));
  console.log(`Verified ${result.files} deployed files at ${productionUrl.origin}`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `url=${productionUrl.origin}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Published [Codex Session Viewer](${productionUrl.origin}). Verified ${result.files} files against the tested artifact, WASM MIME, security/cache headers, and missing-asset 404s.\n`,
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
