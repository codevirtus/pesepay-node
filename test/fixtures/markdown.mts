/**
 * Fenced code blocks, pulled out of the documentation so a compiler can read
 * them.
 *
 * A README snippet that does not compile is the most expensive kind of
 * documentation bug: it is copied before it is run, and the person copying it
 * has no way to tell our mistake from theirs.
 *
 * The info string is `<lang> <tag>…` — GitHub highlights on the first word and
 * ignores the rest, so the tags are free. `v1` marks a block written against
 * the 1.x API, which is checked against `pesepay/v1-compat`; that redirect is
 * the whole claim of the compat layer, made mechanical.
 */

export interface Snippet {
  /** Repo-relative path of the document it came from. */
  file: string;
  /** 1-based line of the opening fence, so a failure points at the source. */
  line: number;
  lang: string;
  tags: readonly string[];
  code: string;
}

/** Languages worth compiling. Everything else — shell, json, text — is prose. */
const CODE_LANGUAGES = new Set(['ts', 'typescript', 'js', 'javascript']);

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

export function extractSnippets(file: string, source: string): Snippet[] {
  const lines = source.split(/\r?\n/);
  const snippets: Snippet[] = [];

  let open: { indent: string; marker: string; line: number; info: string } | undefined;
  let body: string[] = [];

  for (const [index, text] of lines.entries()) {
    const match = FENCE.exec(text ?? '');

    if (open === undefined) {
      if (match?.[2] !== undefined && match[3] !== undefined) {
        open = { indent: match[1] ?? '', marker: match[2], line: index + 1, info: match[3].trim() };
        body = [];
      }
      continue;
    }

    // A closing fence is the same character, at least as long, and carries no
    // info string — otherwise it opens a nested block in some renderers.
    const closes =
      match?.[2] !== undefined &&
      match[2][0] === open.marker[0] &&
      match[2].length >= open.marker.length &&
      (match[3] ?? '').trim() === '';

    if (!closes) {
      body.push(stripIndent(text ?? '', open.indent));
      continue;
    }

    const [lang = '', ...tags] = open.info.split(/\s+/);
    if (CODE_LANGUAGES.has(lang.toLowerCase())) {
      snippets.push({
        file,
        line: open.line,
        lang: lang.toLowerCase(),
        tags,
        code: `${body.join('\n')}\n`,
      });
    }

    open = undefined;
  }

  if (open !== undefined) {
    throw new Error(`${file}:${open.line} — code fence is never closed`);
  }

  return snippets;
}

/** Names imported from `specifier`, type-only imports included. */
export function importedNames(code: string, specifier: string): string[] {
  const quoted = specifier.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
  const patterns = [
    new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]${quoted}['"]`, 'g'),
    new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*['"]${quoted}['"]`, 'g'),
  ];

  const names: string[] = [];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      for (const part of (match[1] ?? '').split(',')) {
        // `type Foo`, `Foo as Bar`, `Foo: Bar` — the imported name is first.
        const name = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+|\s*:\s*/)[0]
          ?.trim();
        if (name !== undefined && name !== '') names.push(name);
      }
    }
  }
  return names;
}

function stripIndent(text: string, indent: string): string {
  return indent !== '' && text.startsWith(indent) ? text.slice(indent.length) : text;
}
