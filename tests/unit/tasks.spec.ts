import chalk from 'chalk';
import type { Debugger } from 'debug';
import type { ListrRenderer, ListrTaskWrapper } from 'listr2';
import { Comparator, Range } from 'semver';
import { beforeEach, describe, expect, it, SpyInstance, vi } from 'vitest';

import {
  checkCommandTasks,
  cliCommandTask,
  computeEnginesConstraints,
  generateUpdateCommandFromContext,
  humanizeRange,
  loadPackageFile,
  loadPackageLockFile,
  outputComputedConstraints,
  rangeOptions,
  restrictiveRange,
  sortRangeSet,
  updatePackageJson,
} from '../../lib/tasks.js';
import type { CheckCommandContext, PackageLockJSONSchema } from '../../lib/types.js';
import * as utils from '../../lib/utils.js';

const packageJsonSchema = require('../../schemas/schema-package.json');
const packageLockJsonSchema = require('../../schemas/schema-package-lock.json');

describe('tasks', () => {
  it('should sort range', () => {
    expect(
      sortRangeSet([
        [new Comparator('>=16.10.0'), new Comparator('<17.0.0-0')],
        [new Comparator('>=14.17.0'), new Comparator('<15.0.0-0')],
      ]),
    ).toEqual([
      [new Comparator('>=14.17.0'), new Comparator('<15.0.0-0')],
      [new Comparator('>=16.10.0'), new Comparator('<17.0.0-0')],
    ]);
    expect(
      sortRangeSet([
        [new Comparator('>=14.17.0'), new Comparator('<15.0.0-0')],
        [new Comparator('>=16.10.0'), new Comparator('<17.0.0-0')],
      ]),
    ).toEqual([
      [new Comparator('>=14.17.0'), new Comparator('<15.0.0-0')],
      [new Comparator('>=16.10.0'), new Comparator('<17.0.0-0')],
    ]);
  });

  describe('should return restrictive range', () => {
    it('w/ r1 subset of r2', () => {
      expect(
        restrictiveRange(
          new Range('^14.17.0 || ^16.10.0'),
          new Range('^14.0.0 || ^16.0.0'),
          [],
          vi.fn() as unknown as Debugger,
        ),
      ).toEqual(new Range('^14.17.0 || ^16.10.0'));
    });

    it('w/ r2 subset of r1', () => {
      expect(
        restrictiveRange(
          new Range('^14.0.0 || ^16.0.0'),
          new Range('^14.17.0 || ^16.10.0'),
          [],
          vi.fn() as unknown as Debugger,
        ),
      ).toEqual(new Range('^14.17.0 || ^16.10.0'));
    });

    it('w/ r1 subset of r2 using min version', () => {
      expect(
        restrictiveRange(
          new Range('^14.13.0 || ^16.10.0'),
          new Range('^14.17.0 || ^16.0.0'),
          [],
          vi.fn() as unknown as Debugger,
        ),
      ).toEqual(new Range('>=14.17.0 <15.0.0-0||>=16.10.0 <17.0.0-0', rangeOptions));
      expect(
        restrictiveRange(
          new Range('^14.13.0 || ^16.10.0'),
          new Range('^12.22.0 || ^14.17.0 || ^16.0.0'),
          [],
          vi.fn() as unknown as Debugger,
        ),
      ).toEqual(new Range('>=14.17.0 <15.0.0-0||>=16.10.0 <17.0.0-0', rangeOptions));
      expect(
        restrictiveRange(
          new Range('^12.22.0 || ^14.17.0'),
          new Range('^14.13.0 || ^16.10.0'),
          [],
          vi.fn() as unknown as Debugger,
        ),
      ).toEqual(new Range('>=14.17.0 <15.0.0-0', rangeOptions));
    });

    it('w/ r2 subset of r1 using min version', () => {
      expect(
        restrictiveRange(
          new Range('^14.17.0 || ^16.0.0'),
          new Range('^14.13.0 || ^16.10.0'),
          [],
          vi.fn() as unknown as Debugger,
        ),
      ).toEqual(new Range('>=14.17.0 <15.0.0-0||>=16.10.0 <17.0.0-0', rangeOptions));
      expect(
        restrictiveRange(
          new Range('^12.22.0 || ^14.17.0 || ^16.0.0'),
          new Range('^14.13.0 || ^16.10.0'),
          [],
          vi.fn() as unknown as Debugger,
        ),
      ).toEqual(new Range('>=14.17.0 <15.0.0-0||>=16.10.0 <17.0.0-0', rangeOptions));
      expect(
        restrictiveRange(
          new Range('^14.13.0 || ^16.10.0'),
          new Range('^12.22.0 || ^14.17.0'),
          [],
          vi.fn() as unknown as Debugger,
        ),
      ).toEqual(new Range('>=14.17.0 <15.0.0-0', rangeOptions));
      expect(
        restrictiveRange(
          new Range('>=12.22.0'),
          new Range('^12.13.0 || ^14.15.0 || ^16.10.0 || >=17.0.0'),
          [],
          vi.fn() as unknown as Debugger,
        ),
      ).toEqual(new Range('>=12.22.0 <13.0.0-0||>=14.15.0 <15.0.0-0||>=16.10.0 <17.0.0-0||>=17.0.0'));
    });

    it('w/ mixed r1 r2', () => {
      expect(
        restrictiveRange(
          new Range('^14.13.0 || ^16.10.0'),
          new Range('^12.22.0 || >=14.17.0'),
          [],
          vi.fn() as unknown as Debugger,
        ),
      ).toEqual(new Range('>=14.17.0 <15.0.0-0||>=16.10.0 <17.0.0-0', rangeOptions));
    });

    it('w/ intersection at middle range', () => {
      expect(
        restrictiveRange(
          new Range('>=14.15.0 <15.0.0-0||>=16.10.0'),
          new Range('>=14.15.0 <15.0.0-0||>=16.0.0 <17.0.0-0||>=17.0.0 <18.0.0-0||>=18.0.0 <19.0.0-0'),
          [],
          vi.fn() as unknown as Debugger,
        ),
      ).toEqual(
        new Range('>=14.15.0 <15.0.0-0||>=16.10.0 <17.0.0-0||>=17.0.0 <18.0.0-0||>=18.0.0 <19.0.0-0', rangeOptions),
      );
    });
  });

  describe('should simplify range', () => {
    it('should return * if range is not defined or range is *', () => {
      expect(humanizeRange(undefined)).toEqual('*');
    });

    it('should return * if range is range is *', () => {
      expect(humanizeRange(new Range('*'))).toEqual('*');
    });

    it('should simplify w/ caret', () => {
      expect(humanizeRange(new Range('>=14.17.0 <15.0.0-0||>=16.10.0 <17.0.0-0'))).toEqual('^14.17.0 || ^16.10.0');
      expect(humanizeRange(new Range('>=14.17.0 <15.0.0-0||>=16.10.0'))).toEqual('^14.17.0 || >=16.10.0');
    });

    it('should not simplify as no simplification implemented', () => {
      expect(humanizeRange(new Range('>14.17.0'))).toEqual('>14.17.0');
      expect(humanizeRange(new Range('14.17.0'))).toEqual('14.17.0');
    });
  });

  it('should return list of tasks', async () => {
    const cmd = checkCommandTasks({
      context: {
        packageObject: {
          filename: 'package.json',
        },
        packageLockObject: {
          filename: 'package-lock.json',
        },
      } as CheckCommandContext,
      parent: {} as unknown as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
      debug: vi.fn() as unknown as Debugger,
    });
    expect(cmd).toEqual([
      expect.objectContaining({
        title: 'Load package.json file...',
        task: expect.any(Function),
      }),
      expect.objectContaining({
        title: 'Load package-lock.json file...',
        task: expect.any(Function),
      }),
      expect.objectContaining({
        title: 'Compute engines range constraints...',
        task: expect.any(Function),
      }),
      expect.objectContaining({
        title: 'Output computed engines range constraints...',
        task: expect.any(Function),
      }),
      expect.objectContaining({
        title: 'Update package.json file...',
        task: expect.any(Function),
      }),
    ]);
  });

  it('should return cliCommandTask', () => {
    expect(
      cliCommandTask(
        { ctx: { packageLockObject: { filename: 'package-lock.json' } } as CheckCommandContext },
        vi.fn() as unknown as Debugger,
      ),
    ).toEqual(
      expect.objectContaining({
        tasks: [
          expect.objectContaining({
            title: 'Checking npm package engines range constraints in package-lock.json file...',
            task: expect.any(Function),
          }),
        ],
      }),
    );
  });

  describe('should output computed constraints', () => {
    it('should throw error', () => {
      const ctx: CheckCommandContext = {} as CheckCommandContext;
      expect.assertions(1);
      try {
        outputComputedConstraints({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error('Computed engines range constraints are not defined.'));
      }
    });

    it('should output simplified computed range constraints when there is no changes', () => {
      const ctx: CheckCommandContext = {
        ranges: new Map([
          [
            'node',
            {
              from: new Range('>=14.17.0 <15.0.0-0||>=16.10.0 <17.0.0-0'),
              to: new Range('>=14.17.0 <15.0.0-0||>=16.10.0 <17.0.0-0'),
            },
          ],
        ]),
      } as CheckCommandContext;
      const parent = {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>;
      Object.defineProperty(parent, 'title', {
        get: vi.fn(() => ''),
        set: vi.fn(),
        configurable: true,
      });
      const spyOnTitle = vi.spyOn(parent, 'title', 'set');
      outputComputedConstraints({
        ctx,
        task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
        parent,
        debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
      });
      expect(spyOnTitle).toHaveBeenCalledWith(
        `All computed engines range constraints are up-to-date ${chalk.green(':)')}`,
      );
      expect(ctx).toEqual(
        expect.objectContaining({
          rangesSimplified: new Map([]),
        }),
      );
    });

    it('should output simplified computed range constraints', () => {
      const ctx: CheckCommandContext = {
        packageObject: { filename: 'package.json' },
        ranges: new Map([
          ['node', { from: new Range('*'), to: new Range('>=14.17.0 <15.0.0-0||>=16.10.0 <17.0.0-0') }],
        ]),
      } as CheckCommandContext;
      const parent = {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>;
      Object.defineProperty(parent, 'title', {
        get: vi.fn(() => ''),
        set: vi.fn(),
        configurable: true,
      });
      const spyOnTitle = vi.spyOn(parent, 'title', 'set');
      outputComputedConstraints({
        ctx,
        task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
        parent,
        debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
      });
      expect(spyOnTitle).toHaveBeenCalledWith(
        `Computed engines range constraints:\n\n node  *  →  ^14.17.0 || ^16.10.0 \n\nRun ${chalk.cyan(
          'nce -u',
        )} to upgrade package.json.`,
      );
      expect(ctx).toEqual(
        expect.objectContaining({
          rangesSimplified: new Map([['node', '^14.17.0 || ^16.10.0']]),
        }),
      );
    });

    it('should output simplified computed range constraints w/ update', () => {
      const ctx: CheckCommandContext = {
        packageObject: { filename: 'package.json' },
        update: true,
        ranges: new Map([
          ['node', { from: new Range('*'), to: new Range('>=14.17.0 <15.0.0-0||>=16.10.0 <17.0.0-0') }],
        ]),
      } as CheckCommandContext;
      const parent = {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>;
      Object.defineProperty(parent, 'title', {
        get: vi.fn(() => ''),
        set: vi.fn(),
        configurable: true,
      });
      const spyOnTitle = vi.spyOn(parent, 'title', 'set');
      outputComputedConstraints({
        ctx,
        task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
        parent,
        debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
      });
      expect(spyOnTitle).toHaveBeenCalledWith(
        `Computed engines range constraints:\n\n node  *  →  ^14.17.0 || ^16.10.0 `,
      );
      expect(ctx).toEqual(
        expect.objectContaining({
          rangesSimplified: new Map([['node', '^14.17.0 || ^16.10.0']]),
        }),
      );
    });
  });

  describe('should compute engine constraint', () => {
    it('should throw error if package data not defined', () => {
      const ctx: CheckCommandContext = {
        packageObject: { filename: 'package.json', data: undefined },
      } as unknown as CheckCommandContext;
      expect.assertions(1);
      try {
        computeEnginesConstraints({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error('package.json data is not defined.'));
      }
    });

    it('should throw error if package lock data not defined', () => {
      const ctx: CheckCommandContext = {
        packageObject: { filename: 'package.json', data: {} },
        packageLockObject: { filename: 'package-lock.json', data: undefined },
      } as unknown as CheckCommandContext;
      expect.assertions(1);
      try {
        computeEnginesConstraints({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error('package-lock.json data is not defined.'));
      }
    });

    it('should throw error if packages is not defined in package lock data', () => {
      const ctx: CheckCommandContext = {
        packageObject: { filename: 'package.json', data: { engines: {} } },
        packageLockObject: { filename: 'package-lock.json', data: {} },
      } as CheckCommandContext;
      expect.assertions(1);
      try {
        computeEnginesConstraints({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error('package-lock.json does not contain packages property.'));
      }
    });

    it('should set mrr in ctx using engines obj even if package data does not contain engines', () => {
      const ctx: CheckCommandContext = {
        packageObject: { filename: 'package.json', data: {} },
        packageLockObject: {
          filename: 'package-lock.json',
          data: { packages: { foo: { engines: { node: '>=12.22.0' } } } } as PackageLockJSONSchema,
        },
      } as CheckCommandContext;
      computeEnginesConstraints({
        ctx,
        task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
        parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
        debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
      });
      expect(ctx).toEqual(
        expect.objectContaining({
          ranges: new Map([['node', new Range('>=12.22.0', rangeOptions)]]),
        }),
      );
    });

    it('should set mrr in ctx using engines obj', () => {
      const ctx: CheckCommandContext = {
        packageObject: { filename: 'package.json', data: { engines: {} } },
        packageLockObject: {
          filename: 'package-lock.json',
          data: { packages: { foo: { engines: { node: '>=12.22.0' } } } } as PackageLockJSONSchema,
        },
      } as CheckCommandContext;
      computeEnginesConstraints({
        ctx,
        task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
        parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
        debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
      });
      expect(ctx).toEqual(
        expect.objectContaining({
          ranges: new Map([['node', new Range('>=12.22.0', rangeOptions)]]),
        }),
      );
    });

    it('should set mrr in ctx using node engines', () => {
      const ctx: CheckCommandContext = {
        engines: ['node'],
        packageObject: { filename: 'package.json', data: { engines: {} } },
        packageLockObject: { data: { packages: { foo: { engines: { node: '>=12.22.0' } } } } as PackageLockJSONSchema },
      } as CheckCommandContext;
      computeEnginesConstraints({
        ctx,
        task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
        parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
        debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
      });
      expect(ctx).toEqual(
        expect.objectContaining({
          ranges: new Map([['node', new Range('>=12.22.0', rangeOptions)]]),
        }),
      );
    });

    it('should throw error if undefined engines', () => {
      const ctx: CheckCommandContext = {
        engines: ['foo'],
        packageObject: { filename: 'package.json', data: { engines: {} } },
        packageLockObject: { data: { packages: { foo: { engines: { node: '>=12.22.0' } } } } as PackageLockJSONSchema },
      } as CheckCommandContext;
      expect.assertions(1);
      try {
        computeEnginesConstraints({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error('No valid constraint key(s).'));
      }
    });

    it('should set mrr in ctx using engines node & npm', () => {
      const ctx: CheckCommandContext = {
        engines: ['node', 'npm'],
        packageObject: { filename: 'package.json', data: { engines: {} } },
        packageLockObject: { data: { packages: { foo: { engines: { node: '>=12.22.0' } } } } as PackageLockJSONSchema },
      } as CheckCommandContext;
      computeEnginesConstraints({
        ctx,
        task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
        parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
        debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
      });
      expect(ctx).toEqual(
        expect.objectContaining({
          ranges: new Map([['node', new Range('>=12.22.0', rangeOptions)]]),
        }),
      );
    });

    it('should set mrr in ctx using engines arr', () => {
      const ctx: CheckCommandContext = {
        packageObject: { filename: 'package.json', data: { engines: {} } },
        packageLockObject: { data: { packages: { foo: { engines: ['node >=12.22.0'] } } } as PackageLockJSONSchema },
      } as CheckCommandContext;
      computeEnginesConstraints({
        ctx,
        task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
        parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
        debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
      });
      expect(ctx).toEqual(
        expect.objectContaining({
          ranges: new Map([['node', new Range('>=12.22.0', rangeOptions)]]),
        }),
      );
    });

    it('should compute mrr & skip invalid range', () => {
      const ctx: CheckCommandContext = {
        packageObject: { filename: 'package.json', data: { engines: {} } },
        packageLockObject: {
          data: {
            packages: {
              foo: { engines: { node: '>=12.22.0' } },
              bar: { engines: { node: '>=a.b.c' } },
              lorem: { engines: { node: '>=14.17.0' } },
            },
          } as PackageLockJSONSchema,
        },
      } as CheckCommandContext;
      computeEnginesConstraints({
        ctx,
        task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
        parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
        debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
      });
      expect(ctx).toEqual(
        expect.objectContaining({
          ranges: new Map([['node', new Range('>=14.17.0', rangeOptions)]]),
        }),
      );
    });

    it('should compute mrr & using ignored range', () => {
      const ctx: CheckCommandContext = {
        packageObject: { filename: 'package.json', data: { engines: {} } },
        packageLockObject: {
          data: {
            packages: {
              foo: { engines: { node: '>=12.22.0' } },
              bar: { engines: { node: '>=14.17.0' } },
              lorem: { engines: { node: '>=12.22.0' } },
              ipsum: { engines: { node: '>=14.17.0' } },
            },
          } as PackageLockJSONSchema,
        },
      } as CheckCommandContext;
      computeEnginesConstraints({
        ctx,
        task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
        parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
        debug: { extend: vi.fn(() => vi.fn()) } as unknown as Debugger,
      });
      expect(ctx).toEqual(
        expect.objectContaining({
          ranges: new Map([['node', new Range('>=14.17.0', rangeOptions)]]),
        }),
      );
    });
  });

  describe('should load package lock file', () => {
    let getJsonSpy: SpyInstance;

    beforeEach(() => {
      getJsonSpy = vi.spyOn(utils, 'getJson');
    });

    it('should throw error if read json throw error', async () => {
      const ctx: CheckCommandContext = {
        path: '',
        workingDir: 'foo',
        packageLockObject: { filename: 'package-lock.json' },
      } as CheckCommandContext;
      getJsonSpy.mockReturnValueOnce(packageLockJsonSchema);
      getJsonSpy.mockRejectedValueOnce('Oops');
      expect.assertions(1);
      try {
        await loadPackageLockFile({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: vi.fn() as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error('package-lock.json is not defined.'));
      }
    });

    it('should throw error if json is undefined', async () => {
      const ctx: CheckCommandContext = {
        path: '',
        workingDir: 'foo',
        packageLockObject: { filename: 'package-lock.json' },
      } as CheckCommandContext;
      getJsonSpy.mockReturnValueOnce(packageLockJsonSchema);
      getJsonSpy.mockReturnValueOnce(Promise.resolve(null));
      expect.assertions(1);
      try {
        await loadPackageLockFile({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: vi.fn() as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error('package-lock.json is not defined.'));
      }
    });

    it('should throw error if json does not contain packages property', async () => {
      const ctx: CheckCommandContext = {
        path: '',
        workingDir: 'foo',
        packageLockObject: { filename: 'package-lock.json' },
      } as CheckCommandContext;
      getJsonSpy.mockReturnValueOnce(packageLockJsonSchema);
      getJsonSpy.mockReturnValueOnce(Promise.resolve({}));
      expect.assertions(1);
      try {
        await loadPackageLockFile({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: vi.fn() as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error(`must have required property 'packages'`));
      }
    });

    it('should throw error if json property packages is undefined', async () => {
      const ctx: CheckCommandContext = {
        path: '',
        workingDir: 'foo',
        packageLockObject: { filename: 'package-lock.json' },
      } as CheckCommandContext;
      getJsonSpy.mockReturnValueOnce(packageLockJsonSchema);
      getJsonSpy.mockReturnValueOnce(Promise.resolve({ packages: undefined }));
      expect.assertions(1);
      try {
        await loadPackageLockFile({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: vi.fn() as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error(`must have required property 'packages'`));
      }
    });

    it('should set package lock object with empty obj', async () => {
      const ctx: CheckCommandContext = {
        path: '',
        workingDir: 'foo',
        packageLockObject: { filename: 'package-lock.json' },
      } as CheckCommandContext;
      getJsonSpy.mockReturnValueOnce(packageLockJsonSchema);
      getJsonSpy.mockReturnValueOnce(Promise.resolve({ packages: {} }));
      await loadPackageLockFile({
        ctx,
        task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
        parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
        debug: vi.fn() as unknown as Debugger,
      });
      expect(ctx).toEqual(
        expect.objectContaining({
          packageLockObject: {
            filename: 'package-lock.json',
            relativePath: 'package-lock.json',
            data: {
              packages: {},
            },
          },
          path: '',
          workingDir: 'foo',
        }),
      );
    });
  });

  describe('should load package file', () => {
    let getJsonSpy: SpyInstance;

    beforeEach(() => {
      getJsonSpy = vi.spyOn(utils, 'getJson');
    });

    it('should throw error if read json throw error', async () => {
      const ctx: CheckCommandContext = {
        path: '',
        workingDir: 'foo',
        packageObject: { filename: 'package.json' },
      } as CheckCommandContext;
      getJsonSpy.mockReturnValueOnce(packageJsonSchema);
      getJsonSpy.mockRejectedValueOnce('Oops');
      expect.assertions(1);
      try {
        await loadPackageFile({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: vi.fn() as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error('package.json is not defined.'));
      }
    });

    it('should throw error if json is undefined', async () => {
      const ctx: CheckCommandContext = {
        path: '',
        workingDir: 'foo',
        packageObject: { filename: 'package.json' },
      } as CheckCommandContext;
      getJsonSpy.mockReturnValueOnce(packageJsonSchema);
      getJsonSpy.mockReturnValueOnce(Promise.resolve(null));
      expect.assertions(1);
      try {
        await loadPackageFile({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: vi.fn() as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error('package.json is not defined.'));
      }
    });

    it('should throw error if json is malformed', async () => {
      const ctx: CheckCommandContext = {
        path: '',
        workingDir: 'foo',
        packageObject: { filename: 'package.json' },
      } as CheckCommandContext;
      getJsonSpy.mockReturnValueOnce(packageJsonSchema);
      getJsonSpy.mockReturnValueOnce(Promise.resolve({ name: ' bar' }));
      expect.assertions(1);
      try {
        await loadPackageFile({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: vi.fn() as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(expect.any(Error));
      }
    });

    it('should set package object with empty obj', async () => {
      const ctx: CheckCommandContext = {
        path: '',
        workingDir: 'foo',
        packageObject: { filename: 'package.json' },
      } as CheckCommandContext;
      getJsonSpy.mockReturnValueOnce(packageJsonSchema);
      getJsonSpy.mockReturnValueOnce(Promise.resolve({ engines: {} }));
      await loadPackageFile({
        ctx,
        task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
        parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
        debug: vi.fn() as unknown as Debugger,
      });
      expect(ctx).toEqual(
        expect.objectContaining({
          packageObject: {
            filename: 'package.json',
            relativePath: 'package.json',
            data: {
              engines: {},
            },
          },
          path: '',
          workingDir: 'foo',
        }),
      );
    });
  });

  describe('should update package.json file', () => {
    let writeJsonSpy: SpyInstance;

    beforeEach(() => {
      writeJsonSpy = vi.spyOn(utils, 'writeJson').mockReturnValueOnce(Promise.resolve());
    });

    it('should throw error if simplifiedComputedRange is undefined', async () => {
      const ctx: CheckCommandContext = {} as CheckCommandContext;
      expect.assertions(1);
      try {
        await updatePackageJson({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: vi.fn() as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error('Simplified computed engines range constraints are not defined.'));
      }
    });

    it('should throw error if package object data is undefined', async () => {
      const ctx: CheckCommandContext = {
        rangesSimplified: new Map([['node', '^14.17.0']]),
        packageObject: {
          filename: 'package.json',
        },
      } as CheckCommandContext;

      expect.assertions(1);
      try {
        await updatePackageJson({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: vi.fn() as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error('package.json data is not defined.'));
      }
    });

    it('should throw error if package object relative path is undefined', async () => {
      const ctx: CheckCommandContext = {
        rangesSimplified: new Map([['node', '^14.17.0']]),
        packageObject: {
          filename: 'package.json',
          data: {},
        },
      } as CheckCommandContext;
      expect.assertions(1);
      try {
        await updatePackageJson({
          ctx,
          task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
          parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
          debug: vi.fn() as unknown as Debugger,
        });
      } catch (e) {
        expect(e).toEqual(new Error('package.json path is not defined.'));
      }
    });

    it('should write json', async () => {
      const ctx: CheckCommandContext = {
        rangesSimplified: new Map([['node', '^14.17.0']]),
        packageObject: {
          filename: 'package.json',
          relativePath: 'foo/package.json',
          data: {},
        },
      } as CheckCommandContext;
      await updatePackageJson({
        ctx,
        task: {} as ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>,
        parent: {} as Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>,
        debug: vi.fn() as unknown as Debugger,
      });
      expect(writeJsonSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          engines: {
            node: '^14.17.0',
          },
        }),
      );
    });
  });

  describe('should generate update command from context', () => {
    it('w/o additional params', () => {
      const context: CheckCommandContext = {} as CheckCommandContext;
      const expected: string = 'nce -u';
      expect(generateUpdateCommandFromContext(context)).toEqual(expected);
    });

    it('w/ custom path', () => {
      const context: CheckCommandContext = { path: 'examples', workingDir: '' } as CheckCommandContext;
      const expected: string = 'nce -p examples -u';
      expect(generateUpdateCommandFromContext(context)).toEqual(expected);
    });

    it('w/ custom engine', () => {
      const context: CheckCommandContext = { engines: ['node'] } as CheckCommandContext;
      const expected: string = 'nce -e node -u';
      expect(generateUpdateCommandFromContext(context)).toEqual(expected);
    });

    it('w/ custom engines', () => {
      const context: CheckCommandContext = { engines: ['node', 'yarn'] } as CheckCommandContext;
      const expected: string = 'nce -e node -e yarn -u';
      expect(generateUpdateCommandFromContext(context)).toEqual(expected);
    });

    it('w/ quiet mode', () => {
      const context: CheckCommandContext = { quiet: true } as CheckCommandContext;
      const expected: string = 'nce -q -u';
      expect(generateUpdateCommandFromContext(context)).toEqual(expected);
    });

    it('w/ verbose mode', () => {
      const context: CheckCommandContext = { verbose: true } as CheckCommandContext;
      const expected: string = 'nce -v -u';
      expect(generateUpdateCommandFromContext(context)).toEqual(expected);
    });

    it('w/ debug mode', () => {
      const context: CheckCommandContext = { debug: true } as CheckCommandContext;
      const expected: string = 'nce -d -u';
      expect(generateUpdateCommandFromContext(context)).toEqual(expected);
    });
  });
});
