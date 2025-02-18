import type { AnySchema, ValidateFunction } from 'ajv';
import chalk from 'chalk';
import Table from 'cli-table';
import type { Debugger } from 'debug';
import {
  Listr,
  ListrBaseClassOptions,
  ListrRenderer,
  ListrRendererFactory,
  ListrRendererValue,
  ListrTask,
  ListrTaskResult,
  ListrTaskWrapper,
} from 'listr2';
import lodash from 'lodash';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import sortPackageJson from 'sort-package-json';

import { ajv, packageJSONSchema, packageLockJSONSchema } from './json-schema-validator.js';
import {
  CheckCommandContext,
  EngineConstraintChange,
  EngineConstraintKey,
  EngineConstraintKeys,
  FileObject,
  LockPackage,
  LockPackageEngines,
  LockPackageEnginesObject,
  PackageJSONSchema,
  PackageLockJSONSchema,
} from './types.js';
import { getJson, getRelativePath, joinPath, writeJson } from './utils.js';

export type Task<Ctx, Renderer extends ListrRendererFactory = any> = (args: {
  ctx: Ctx;
  task: ListrTaskWrapper<Ctx, Renderer>;
  parent: Omit<ListrTaskWrapper<Ctx, Renderer>, 'skip' | 'enabled'>;
  debug: Debugger;
}) => void | ListrTaskResult<Ctx>;
export type CheckCommandTask = Task<CheckCommandContext>;

export const rangeOptions: semver.Options = { loose: false };

export const sortRangeSet = (set: ReadonlyArray<ReadonlyArray<semver.Comparator>>): semver.Comparator[][] =>
  [...set.map(comp => [...comp])].sort((a, b) => semver.compare(a[0].semver, b[0].semver));

export const setToRange = (set: semver.Comparator[][]): semver.Range =>
  new semver.Range(set.map(tuple => tuple.map(comp => comp.value).join(' ')).join('||'), rangeOptions);

export const applyMinVersionToRangeSet = (
  set: ReadonlyArray<ReadonlyArray<semver.Comparator>>,
  minVersion: semver.SemVer,
): semver.Comparator[][] =>
  [...set.map(comp => [...comp])]
    .filter(c => c[0].semver.major >= minVersion.major)
    .map(c => {
      if (c[0].semver.major === minVersion.major && semver.gte(minVersion, c[0].semver, rangeOptions)) {
        c[0] = new semver.Comparator(`${c[0].operator}${minVersion.raw}`);
      }

      return c;
    });

export const restrictiveRange = (
  r1: semver.Range,
  r2: semver.Range,
  ignoredRanges: string[],
  debug: Debugger,
): semver.Range => {
  debug(`${chalk.white('Compare:')} ${chalk.blue(r1.raw)} ${chalk.white('and')} ${chalk.blue(r2.raw)}`);

  if (semver.subset(r1, r2)) {
    debug(`${chalk.white('Range')} ${chalk.green(r1.raw)} ${chalk.white('is a subset of')} ${chalk.blue(r2.raw)}`);
    ignoredRanges.push(r2.raw);
    return r1;
  } else if (semver.subset(r2, r1)) {
    debug(`${chalk.white('Range')} ${chalk.green(r2.raw)} ${chalk.white('is a subset of')} ${chalk.blue(r1.raw)}`);
    ignoredRanges.push(r1.raw);
    return r2;
  }

  const minVersion1 = semver.minVersion(r1, rangeOptions) || new semver.SemVer('*');
  const minVersion2 = semver.minVersion(r2, rangeOptions) || new semver.SemVer('*');
  const sortedR1: semver.Comparator[][] = sortRangeSet(r1.set);
  const sortedR2: semver.Comparator[][] = sortRangeSet(r2.set);

  if (!semver.eq(minVersion1, minVersion2, rangeOptions)) {
    const minSemver = semver.compare(minVersion1, minVersion2) === -1 ? minVersion2 : minVersion1;
    debug(
      `${chalk.white('Applying minimal version')} ${chalk.yellow(minSemver.version)} ${chalk.white('to both ranges.')}`,
    );

    const newR1 = setToRange(applyMinVersionToRangeSet(sortedR1, minSemver));
    const newR2 = setToRange(applyMinVersionToRangeSet(sortedR2, minSemver));

    if (newR1.intersects(newR2, rangeOptions)) {
      return restrictiveRange(newR1, newR2, ignoredRanges, debug);
    } else {
      throw new Error('Not yet implemented :/');
    }
  }

  const minComp1: semver.Comparator[] | undefined = sortedR1.shift();
  const minComp2: semver.Comparator[] | undefined = sortedR2.shift();
  const minComp: semver.Comparator[] | undefined = minComp1 || minComp2;

  if (!minComp) {
    throw new Error('Not yet implemented :/');
  }

  const set: semver.Comparator[][] = [minComp];
  const newR1 = setToRange(sortedR1);
  const newR2 = setToRange(sortedR2);
  const newRange = restrictiveRange(newR1, newR2, ignoredRanges, debug);
  set.push(...sortRangeSet(newRange.set));
  return setToRange(set);
};

export const humanizeRange = (range?: semver.Range): string => {
  if (!range || '*' === range.raw) {
    return '*';
  }

  const res: string[] = [];

  const set = sortRangeSet(range.set);

  set.forEach(comps => {
    const [from, to] = comps;
    if (
      comps.length === 2 &&
      from.operator === '>=' &&
      to.operator === '<' &&
      from.semver.major + 1 === to.semver.major
    ) {
      res.push(`^${from.semver.version}`);
    } else if (comps.length === 1 && from.operator === '>=') {
      res.push(from.value);
    } else {
      res.push(`${from.value} ${to?.value || ''}`.trim());
    }
  });

  return res.join(' || ');
};

const loadFile = async <T>({
  fileObject,
  path,
  workingDir,
  debug,
  validateFn,
}: {
  fileObject: FileObject<T>;
  workingDir: string;
  path: string;
  debug: Debugger;
  validateFn: ValidateFunction<T>;
}): Promise<FileObject<T>> => {
  const pathToFile = joinPath(path, fileObject.filename);
  const relativePath = getRelativePath({ path: pathToFile, workingDir });
  debug(`${chalk.white(`Relative path to ${fileObject.filename}:`)} ${chalk.blue(relativePath)}`);

  const jsonObject: T | undefined = await getJson<T>(relativePath).catch(() => undefined);

  if (!jsonObject) {
    throw new Error(`${relativePath} is not defined.`);
  }

  debug(`${chalk.white(`Validate JSON schema of`)} ${chalk.blue(relativePath)}`);
  const data = validateFn(jsonObject);

  if (!data) {
    throw new Error(validateFn.errors?.map(e => e.message).join('\n'));
  }

  fileObject.relativePath = relativePath;
  fileObject.data = jsonObject;

  return fileObject;
};

export const loadPackageFile: CheckCommandTask = async ({ ctx, debug }): Promise<void> => {
  const { path, workingDir, packageObject } = ctx;

  const pathToFile = joinPath(dirname(fileURLToPath(import.meta.url)), packageJSONSchema);
  const relativePath = getRelativePath({ path: pathToFile, workingDir });
  const packageJSONSchemaObj = await getJson<AnySchema>(relativePath);
  const validateFn = ajv.compile<PackageJSONSchema>(packageJSONSchemaObj);

  ctx.packageObject = await loadFile<PackageJSONSchema>({
    fileObject: packageObject,
    path,
    debug,
    workingDir,
    validateFn,
  });
};

export const loadPackageLockFile: CheckCommandTask = async ({ ctx, debug }): Promise<void> => {
  const { path, workingDir, packageLockObject } = ctx;

  const pathToFile = joinPath(dirname(fileURLToPath(import.meta.url)), packageLockJSONSchema);
  const relativePath = getRelativePath({ path: pathToFile, workingDir });
  const packageLockJSONSchemaObj = await getJson<AnySchema>(relativePath);
  const validateFn = ajv.compile<PackageLockJSONSchema>(packageLockJSONSchemaObj);

  ctx.packageLockObject = await loadFile<PackageLockJSONSchema>({
    fileObject: packageLockObject,
    path,
    debug,
    workingDir,
    validateFn,
  });
};

const getConstraintFromEngines = (
  engines: LockPackageEngines,
  constraintKey: EngineConstraintKey,
): string | undefined => {
  if (typeof engines === 'object' && constraintKey in engines) {
    return (engines as LockPackageEnginesObject)[constraintKey];
  } else if (lodash.isArray(engines) && engines.some(constraint => constraint.includes(constraintKey))) {
    return engines.find(constraint => constraint.includes(constraintKey))?.replace(constraintKey, '');
  }

  return undefined;
};

const computeEnginesConstraint = ({
  packages,
  constraintKey,
  debug,
}: {
  packages: [string, LockPackage][];
  constraintKey: EngineConstraintKey;
  debug: Debugger;
}): semver.Range | never => {
  let mrr: semver.Range = new semver.Range('*');
  const ignoredRanges: string[] = [];
  const debugConstraint = debug.extend(constraintKey);

  for (const [pkgName, pkg] of packages) {
    const { engines } = pkg;
    let constraint: string | undefined = getConstraintFromEngines(engines, constraintKey);

    if (!constraint) {
      debugConstraint(
        `${chalk.white('Package')} ${chalk.gray(pkgName)} ${chalk.white('has no constraints for current engine')}`,
      );
      continue;
    }

    const rawValidRange = semver.validRange(constraint);
    if (!rawValidRange) {
      debugConstraint(`${chalk.red(constraint)} ${chalk.white('is not a valid semver range')}`);
      continue;
    }

    if (ignoredRanges.indexOf(rawValidRange) !== -1) {
      debugConstraint(`${chalk.white('Ignored range:')} ${chalk.gray(rawValidRange)}`);
      continue;
    }

    const range = new semver.Range(rawValidRange, rangeOptions);

    if (!mrr) {
      mrr = range;
      debugConstraint(`${chalk.white('New most restrictive range:')} ${chalk.green(mrr.raw)}`);
      continue;
    }

    const newRestrictiveRange = restrictiveRange(mrr, range, ignoredRanges, debugConstraint);
    if (mrr.raw !== newRestrictiveRange.raw) {
      mrr = newRestrictiveRange;
      debugConstraint(`${chalk.white('New most restrictive range:')} ${chalk.green(mrr.raw)}`);
    }
  }

  if (mrr) {
    debugConstraint(`${chalk.white(`Final computed engine range constraint:`)} ${chalk.blue(mrr.raw)}`);
  } else {
    debugConstraint(`${chalk.white(`No computed engine range constraint`)}`);
  }

  return mrr;
};

export const computeEnginesConstraints: CheckCommandTask = ({ ctx, debug }): void => {
  const { packageObject, packageLockObject, engines } = ctx;

  if (!packageObject.data) {
    throw new Error(`${packageObject.filename} data is not defined.`);
  }

  if (!packageLockObject.data) {
    throw new Error(`${packageLockObject.filename} data is not defined.`);
  }

  if (!('packages' in packageLockObject.data)) {
    throw new Error(`${packageLockObject.filename} does not contain packages property.`);
  }

  const filterEngineConstraintKey = (key: string): key is EngineConstraintKey =>
    -1 !== EngineConstraintKeys.indexOf(key as EngineConstraintKey);
  const packages = Object.entries(packageLockObject.data.packages);
  const ranges = new Map<EngineConstraintKey, EngineConstraintChange>();
  let constraintKeys: EngineConstraintKey[] = [...EngineConstraintKeys];

  if (engines && engines.length > 0) {
    constraintKeys = engines.filter(filterEngineConstraintKey);
  }

  if (0 === constraintKeys.length) {
    throw new Error(`No valid constraint key(s).`);
  }

  for (const constraintKey of constraintKeys) {
    ranges.set(constraintKey, {
      from: computeEnginesConstraint({
        packages: [['', { engines: packageObject.data.engines || {} }]],
        constraintKey,
        debug,
      }),
      to: computeEnginesConstraint({ packages, constraintKey, debug }),
    });
  }

  ctx.ranges = ranges;
};

const createEnginesTable = (colWidths: number[]): Table => {
  return new Table({
    style: {
      head: [],
      border: [],
      compact: false,
      'padding-left': 1,
      'padding-right': 1,
    },
    colWidths,
    colAligns: ['left', 'left', 'left', 'left'],
    chars: {
      top: '',
      'top-mid': '',
      'top-left': '',
      'top-right': '',
      bottom: '',
      'bottom-mid': '',
      'bottom-left': '',
      'bottom-right': '',
      left: '',
      'left-mid': '',
      mid: '',
      'mid-mid': '',
      right: '',
      'right-mid': '',
      middle: '',
    },
  });
};

export const generateUpdateCommandFromContext = (ctx: CheckCommandContext): string => {
  const argv: string[] = ['nce'];

  let path: string | undefined = undefined;
  if (typeof ctx.path === 'string' && ctx.path.length > 0) {
    path = getRelativePath({ path: ctx.path, workingDir: ctx.workingDir });
  }

  if (typeof path === 'string' && path.length > 0) {
    argv.push(...['-p', path]);
  }

  if (ctx.engines) {
    argv.push(...ctx.engines.map(e => ['-e', e]).flat());
  }

  if (ctx.quiet) {
    argv.push('-q');
  }

  if (ctx.debug) {
    argv.push('-d');
  }

  if (ctx.verbose) {
    argv.push('-v');
  }

  argv.push('-u');

  return argv.join(' ');
};

export const outputComputedConstraints: CheckCommandTask = ({ ctx, parent, debug }): void => {
  const { ranges, packageObject, update } = ctx;

  if (!ranges) {
    throw new Error(`Computed engines range constraints are not defined.`);
  }

  const rangesSimplified = new Map<EngineConstraintKey, string | undefined>();
  const arrowSeparator: string = '→';
  let colWidths: [number, number, number, number] = [2, 2, 2, 2];
  let colValues: [string, string, string, string][] = [];

  for (const [engine, range] of ranges.entries()) {
    const rangeToHumanized = humanizeRange(range.to);
    const rangeFromHumanized = humanizeRange(range.from);

    if (rangeToHumanized === rangeFromHumanized) {
      continue;
    }

    rangesSimplified.set(engine, rangeToHumanized);
    debug.extend(engine)(
      `${chalk.white(`Simplified computed engine range constraint:`)} ${chalk.blue(rangeToHumanized)}`,
    );
    colWidths = [
      Math.max(colWidths[0], engine.length + 2),
      Math.max(colWidths[1], rangeFromHumanized.length + 2),
      arrowSeparator.length + 2,
      Math.max(colWidths[3], rangeToHumanized.length + 2),
    ];
    colValues.push([engine, rangeFromHumanized, arrowSeparator, rangeToHumanized]);
  }

  if (0 === rangesSimplified.size) {
    parent.title = `All computed engines range constraints are up-to-date ${chalk.green(':)')}`;
  } else {
    const table: Table = createEnginesTable(colWidths);
    table.push(...colValues);
    let title = `Computed engines range constraints:\n\n${table.toString()}`;

    if (!update) {
      title += `\n\nRun ${chalk.cyan(generateUpdateCommandFromContext(ctx))} to upgrade ${packageObject.filename}.`;
    }

    parent.title = title;
  }

  ctx.rangesSimplified = rangesSimplified;
};

export const updatePackageJson: CheckCommandTask = async ({ ctx, debug }): Promise<void> => {
  const { packageObject, rangesSimplified } = ctx;

  if (!rangesSimplified) {
    throw new Error(`Simplified computed engines range constraints are not defined.`);
  }

  if (!packageObject.data) {
    throw new Error(`${packageObject.filename} data is not defined.`);
  }

  if (!packageObject.relativePath) {
    throw new Error(`${packageObject.filename} path is not defined.`);
  }

  packageObject.data.engines = lodash.merge({}, packageObject.data.engines, Object.fromEntries(rangesSimplified));

  debug(`${chalk.white(`Write JSON to`)} ${chalk.blue(packageObject.relativePath)}`);
  return writeJson(packageObject.relativePath, sortPackageJson(packageObject.data));
};

export const checkCommandTasks = ({
  context,
  parent,
  debug,
}: {
  context: CheckCommandContext;
  parent: Omit<ListrTaskWrapper<CheckCommandContext, typeof ListrRenderer>, 'skip' | 'enabled'>;
  debug: Debugger;
}): ListrTask<CheckCommandContext>[] => [
  {
    title: `Load ${context.packageObject.filename} file...`,
    task: (ctx, task) => loadPackageFile({ ctx, task, parent, debug }),
  },
  {
    title: `Load ${context.packageLockObject.filename} file...`,
    task: (ctx, task) => loadPackageLockFile({ ctx, task, parent, debug }),
  },
  {
    title: 'Compute engines range constraints...',
    task: (ctx, task) => computeEnginesConstraints({ ctx, task, parent, debug }),
  },
  {
    title: 'Output computed engines range constraints...',
    task: (ctx, task) => outputComputedConstraints({ ctx, task, parent, debug }),
  },
  {
    title: `Update ${context.packageObject.filename} file...`,
    skip: ({ update }) => (!update ? 'Update is disabled by default.' : !update),
    task: (ctx, task) => updatePackageJson({ ctx, task, parent, debug }),
  },
];

export const cliCommandTask = (
  options: ListrBaseClassOptions<CheckCommandContext, ListrRendererValue>,
  debug: Debugger,
): Listr<CheckCommandContext, ListrRendererValue> =>
  new Listr(
    [
      {
        title: `Checking npm package engines range constraints in ${options.ctx?.packageLockObject.filename} file...`,
        task: (ctx, task) => {
          const { path, workingDir, packageLockObject } = ctx;
          const completePath = joinPath(workingDir, path, packageLockObject.filename);
          task.title = `Checking npm package engines range constraints in ${completePath.replace(
            `${workingDir}${sep}`,
            '',
          )} file...`;
          return task.newListr(parent => checkCommandTasks({ context: ctx, parent, debug }));
        },
      },
    ],
    options,
  );
