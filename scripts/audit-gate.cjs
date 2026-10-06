/**
 * CI dependency gate: fail on any high/critical advisory in production dependencies,
 * EXCEPT the explicitly accepted, documented ones below. Anything new fails the build.
 *
 * Accepted: all four come from the `prisma` CLI's own toolchain. They are not reachable from the
 * running application: the app talks to PostgreSQL only (mysql2 is never loaded), and the CLI only
 * ever parses our own prisma.config.ts. The npm-suggested "fix" is downgrading Prisma 7 -> 6, which
 * would be a regression. Revisit whenever Prisma ships a release that updates these.
 */
const { spawnSync } = require('node:child_process');

const ACCEPTED = new Map([
  ['mysql2', 'prisma CLI toolchain only; app uses PostgreSQL, mysql2 is never loaded'],
  ['deepmerge-ts', 'prisma CLI config loader only; merges our own prisma.config.ts'],
  ['@prisma/config', 'prisma CLI config loader (transitive of deepmerge-ts)'],
  ['prisma', 'prisma CLI (transitive of the above); not part of the runtime request path'],
]);

const res = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  console.error('Could not parse npm audit output:\n', res.stdout, res.stderr);
  process.exit(2);
}

const failing = [];
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  if (!['high', 'critical'].includes(v.severity)) continue;
  if (ACCEPTED.has(name)) {
    console.log(`accepted: ${name} (${v.severity}) — ${ACCEPTED.get(name)}`);
    continue;
  }
  failing.push(`${name} (${v.severity})`);
}

if (failing.length) {
  console.error(`\nUnaccepted high/critical vulnerabilities in production dependencies:\n  - ${failing.join('\n  - ')}`);
  process.exit(1);
}
console.log('Dependency audit passed.');
