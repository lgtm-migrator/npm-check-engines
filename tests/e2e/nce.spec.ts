import { execaCommand, Options } from 'execa';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('nce', () => {
  it('should check engines from examples lock file', async () => {
    const execaOptions: Options = {
      cwd: resolve(__dirname, '..', '..', 'examples'),
      stdio: 'pipe',
      cleanup: true,
    };
    const { stdout } = await execaCommand(
      `node --experimental-specifier-resolution=node --loader ts-node/esm ../bin/nce.ts`,
      execaOptions,
    );
    expect(stdout).toEqual(
      '[STARTED] Checking npm package engines range constraints in package-lock.json file...\n' +
        `[TITLE] Checking npm package engines range constraints in package-lock.json file...\n` +
        '[STARTED] Load package.json file...\n' +
        '[SUCCESS] Load package.json file...\n' +
        '[STARTED] Load package-lock.json file...\n' +
        '[SUCCESS] Load package-lock.json file...\n' +
        '[STARTED] Compute engines range constraints...\n' +
        '[SUCCESS] Compute engines range constraints...\n' +
        '[STARTED] Output computed engines range constraints...\n' +
        '[TITLE] Computed engines range constraints:\n' +
        '[TITLE] \n' +
        '[TITLE]  node  *  →  ^14.17.0 || ^16.10.0 || >=17.0.0 \n' +
        '[TITLE] \n' +
        `[TITLE] Run nce -u to upgrade package.json.\n` +
        '[SUCCESS] Output computed engines range constraints...\n' +
        '[STARTED] Update package.json file...\n' +
        '[SKIPPED] Update is disabled by default.\n' +
        '[SUCCESS] Computed engines range constraints:\n' +
        '[SUCCESS] \n' +
        '[SUCCESS]  node  *  →  ^14.17.0 || ^16.10.0 || >=17.0.0 \n' +
        '[SUCCESS] \n' +
        `[SUCCESS] Run nce -u to upgrade package.json.`,
    );
  }, 10000);

  it('should check engines from examples lock file using path option', async () => {
    const execaOptions: Options = { cwd: resolve(__dirname, '..', '..'), stdio: 'pipe', cleanup: true };
    const { stdout } = await execaCommand(
      `node --experimental-specifier-resolution=node --loader ts-node/esm bin/nce.ts -p examples`,
      execaOptions,
    );
    expect(stdout).toEqual(
      '[STARTED] Checking npm package engines range constraints in package-lock.json file...\n' +
        `[TITLE] Checking npm package engines range constraints in examples${sep}package-lock.json file...\n` +
        '[STARTED] Load package.json file...\n' +
        '[SUCCESS] Load package.json file...\n' +
        '[STARTED] Load package-lock.json file...\n' +
        '[SUCCESS] Load package-lock.json file...\n' +
        '[STARTED] Compute engines range constraints...\n' +
        '[SUCCESS] Compute engines range constraints...\n' +
        '[STARTED] Output computed engines range constraints...\n' +
        '[TITLE] Computed engines range constraints:\n' +
        '[TITLE] \n' +
        '[TITLE]  node  *  →  ^14.17.0 || ^16.10.0 || >=17.0.0 \n' +
        '[TITLE] \n' +
        `[TITLE] Run nce -p examples -u to upgrade package.json.\n` +
        '[SUCCESS] Output computed engines range constraints...\n' +
        '[STARTED] Update package.json file...\n' +
        '[SKIPPED] Update is disabled by default.\n' +
        '[SUCCESS] Computed engines range constraints:\n' +
        '[SUCCESS] \n' +
        '[SUCCESS]  node  *  →  ^14.17.0 || ^16.10.0 || >=17.0.0 \n' +
        '[SUCCESS] \n' +
        `[SUCCESS] Run nce -p examples -u to upgrade package.json.`,
    );
  }, 10000);
});
