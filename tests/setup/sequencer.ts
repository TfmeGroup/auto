import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * Run the test files in a fixed order: alphabetical by path, except that files named `zz-*` always go last. Vitest otherwise orders files by how
 * long they took and whether they failed last time, which changes from run to run. The suite shares one database, and the whole-database audit
 * `tests/e2e/zz-data-integrity.test.ts` checks EVERYTHING the earlier files created, so it must always run after all of them: with a moving order
 * its result would depend on luck.
 */
const isLast = (f: TestSpecification) => /[\\/]zz-[^\\/]*$/.test(f.moduleId);

export default class AlphabeticalSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => Number(isLast(a)) - Number(isLast(b)) || (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
  }
}
