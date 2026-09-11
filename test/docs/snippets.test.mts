/**
 * Every code block in the documentation, compiled against the built package.
 *
 * The snippets are extracted into `test/docs/generated/` and handed to one
 * `tsc` run. They resolve `pesepay` and `pesepay/v1-compat` by self-reference
 * through this package's own `exports` map, so they are checked against the
 * declarations a consumer installs — not against `src/`.
 *
 * Two mechanical rewrites happen on the way in, and both are narrow:
 *
 * - `require('x')` becomes `require('x') as typeof import('x')`. TypeScript
 *   types a bare `require()` as `any`, so without this the v1 blocks — the ones
 *   whose whole promise is that they are unchanged — would compile no matter
 *   what they said.
 * - A block tagged `v1` has `require('pesepay')` redirected to
 *   `require('pesepay/v1-compat')`. That redirect *is* the compat layer's
 *   claim, so the test makes it and compiles the result.
 *
 * The names the documentation elides — `app`, `log`, a database — are declared
 * as ambient globals. A snippet that declares its own `pesepay` shadows the
 * global one, which is why every generated file is forced to be a module.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractSnippets, importedNames, type Snippet } from '../fixtures/markdown.mts';
import { PUBLIC_TYPES, PUBLIC_VALUES, V1_COMPAT_VALUES } from '../fixtures/public-api.mts';

const DOCUMENTS = ['README.md', 'MIGRATION.md', 'CHANGELOG.md'] as const;

const repoPath = (p: string): string => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const read = (p: string): string => readFileSync(repoPath(p), 'utf8');

const OUT_DIR = repoPath('test/docs/generated');

/**
 * What the prose leaves out. These are `var` declarations so a snippet's own
 * `const pesepay = new Pesepay(…)` shadows rather than collides with them.
 */
const GLOBALS = `
declare var pesepay: import('pesepay').Pesepay;
declare var referenceNumber: string;
declare var pollUrl: string;
declare var log: {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
declare var express: { json(): RequestHandler };
declare var app: { post(path: string, ...handlers: RequestHandler[]): void };
declare function creditOnce(
  referenceNumber: string,
  transactionStatus: string,
  result: import('pesepay').PaymentResult,
): Promise<void>;
declare function saveOrder(order: {
  referenceNumber: string;
  pollUrl: string;
  redirectUrl?: string;
}): Promise<void>;
interface DocsRequest {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}
interface DocsResponse {
  sendStatus(code: number): void;
  redirect(url: string): void;
}
type RequestHandler = (req: DocsRequest, res: DocsResponse) => unknown;
`;

const TSCONFIG = {
  extends: '../../../tsconfig.json',
  compilerOptions: {
    noEmit: true,
    allowImportingTsExtensions: false,
    // A snippet is an excerpt: it is allowed to bind a value and stop there.
    noUnusedLocals: false,
    noUnusedParameters: false,
  },
  include: ['.'],
  // The root config excludes this directory, so that `npm run typecheck` does
  // not trip over output that only exists mid-test. Undo that here.
  exclude: [],
};

const snippets: Snippet[] = DOCUMENTS.flatMap((file) => extractSnippets(file, read(file)));

/** `tsc` reports by file, so the name has to carry the origin back. */
const fileNameOf = (snippet: Snippet, index: number): string => {
  const stem = `${snippet.file.replace(/\.md$/, '').toLowerCase()}-L${snippet.line}-${index}`;
  // `require` needs CommonJS; everything else gets ESM, which allows top-level
  // await — the form every async example in these documents uses.
  return `${stem}.${snippet.code.includes('require(') ? 'cts' : 'mts'}`;
};

/**
 * A `v1` block talks to the 1.x client, so `pesepay` has to mean that one —
 * unless the block builds its own, where shadowing would be a redeclaration.
 */
const v1Client = (code: string): string =>
  /\b(?:const|let|var)\s+pesepay\b/.test(code)
    ? ''
    : "declare const pesepay: import('pesepay/v1-compat').Pesepay;\n";

const prepare = (snippet: Snippet): string => {
  const redirected = snippet.tags.includes('v1')
    ? snippet.code.replace(
        /require\((\s*['"])pesepay(['"]\s*)\)/g,
        'require($1pesepay/v1-compat$2)',
      )
    : snippet.code;

  const typed = redirected.replace(
    /require\(\s*(['"])([^'"]+)\1\s*\)/g,
    (_match, quote: string, specifier: string) =>
      `require(${quote}${specifier}${quote}) as typeof import(${quote}${specifier}${quote})`,
  );

  const prelude = snippet.tags.includes('v1') ? v1Client(snippet.code) : '';

  // `export {}` forces module scope, so the ambient globals can be shadowed.
  return `${prelude}${typed}\nexport {};\n`;
};

describe('documentation — the code blocks compile', () => {
  it('finds code blocks in every document', () => {
    for (const file of DOCUMENTS) {
      const found = snippets.filter((snippet) => snippet.file === file);
      assert.ok(found.length > 0, `${file} has no fenced code blocks — did it move?`);
    }
  });

  it('type-checks every snippet against the built package', () => {
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });

    writeFileSync(`${OUT_DIR}/tsconfig.json`, JSON.stringify(TSCONFIG, null, 2));
    writeFileSync(`${OUT_DIR}/globals.d.ts`, GLOBALS);

    const origins = new Map<string, Snippet>();
    for (const [index, snippet] of snippets.entries()) {
      const name = fileNameOf(snippet, index);
      origins.set(name, snippet);
      writeFileSync(`${OUT_DIR}/${name}`, prepare(snippet));
    }

    const tsc = spawnSync(
      process.execPath,
      [repoPath('node_modules/typescript/bin/tsc'), '-p', `${OUT_DIR}/tsconfig.json`],
      { encoding: 'utf8' },
    );

    // Map tsc's generated-file names back to the markdown that produced them,
    // so a failure names a document and a line rather than a temp file.
    const report = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`.replace(
      /([\w.-]+\.[mc]ts)\((\d+),/g,
      (match, name: string, line: string) => {
        const origin = origins.get(name);
        return origin === undefined ? match : `${origin.file}:${origin.line}+${line} (`;
      },
    );

    assert.equal(tsc.status, 0, `documentation snippets do not compile:\n\n${report}`);
  });
});

describe('documentation — it references only the public API', () => {
  it('imports nothing from pesepay that is not exported', () => {
    const documented = new Set<string>([...PUBLIC_VALUES, ...PUBLIC_TYPES]);

    for (const snippet of snippets) {
      // A `v1` block's `pesepay` is the compat entry point; the next test owns it.
      if (snippet.tags.includes('v1')) continue;

      for (const name of importedNames(snippet.code, 'pesepay')) {
        assert.ok(
          documented.has(name),
          `${snippet.file}:${snippet.line} documents ${name}, which is not in the public API. ` +
            'Export it from src/index.ts and add it to test/fixtures/public-api.mts, or ' +
            'drop it from the docs.',
        );
      }
    }
  });

  it('imports nothing from pesepay/v1-compat that v1 did not have', () => {
    const v1Surface = new Set<string>(V1_COMPAT_VALUES);

    for (const snippet of snippets) {
      const names = [
        ...importedNames(snippet.code, 'pesepay/v1-compat'),
        // A `v1` block still says `require('pesepay')`; that is the point.
        ...(snippet.tags.includes('v1') ? importedNames(snippet.code, 'pesepay') : []),
      ];

      for (const name of names) {
        assert.ok(
          v1Surface.has(name),
          `${snippet.file}:${snippet.line} documents ${name}, which ` +
            'pesepay/v1-compat does not export.',
        );
      }
    }
  });
});
