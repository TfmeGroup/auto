import { defineConfig } from 'vitest/config';
import AlphabeticalSequencer from './tests/setup/sequencer';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/global.ts'],
    setupFiles: ['tests/setup/env.ts'],
    // One shared Postgres; files run sequentially so DB-level assertions stay deterministic.
    fileParallelism: false,
    // A fixed order, so the whole-database integrity audit (zz-*) always runs after every file whose data it audits.
    sequence: { sequencer: AlphabeticalSequencer },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
