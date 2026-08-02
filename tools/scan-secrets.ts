/**
 * Pre-commit secret and PII scanner.
 *
 *   npm run scan
 *
 * This project handles live session cookies for a real account with a saved payment
 * method, and the discovery workflow routinely produces files full of them. `.gitignore`
 * is the primary defence; this is the check that the primary defence actually held.
 *
 * It scans only files git would actually commit (tracked + untracked-not-ignored), so an
 * ignored `captures/` directory full of real cookies is correctly not a finding.
 *
 * Exits non-zero on any finding, so it can gate a commit or CI.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

interface Rule {
  name: string;
  pattern: RegExp;
  /** Why this matters, shown when it fires. */
  note: string;
}

const RULES: Rule[] = [
  {
    name: 'email address',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    note: 'personal identifier',
  },
  {
    name: 'HEB session cookie',
    pattern: /\b(reese84|sat|sst\.sig|sst|_session|visid_incap_\d+)\s*=\s*[A-Za-z0-9%_.+/-]{16,}/g,
    note: 'live credential — rotate immediately if this ever reached a remote',
  },
  {
    // `FileStore` and Playwright both serialise cookies as objects, so the header-style
    // rule above cannot see them. A session copied to a filename `.gitignore` does not
    // cover would otherwise scan clean while holding the primary live credentials.
    name: 'serialised cookie jar',
    pattern: /"name"\s*:\s*"(reese84|sat|sst|sst\.sig|_session[^"]*|visid_incap_\d+)"\s*,\s*"value"\s*:\s*"[^"]{16,}"/g,
    note: 'live credential in JSON form — this is what a session/storage-state file looks like',
  },
  {
    name: 'bearer token',
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}/g,
    note: 'live credential',
  },
  {
    name: 'AWS access key',
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    note: 'live credential',
  },
  {
    name: 'private key block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    note: 'live credential',
  },
  {
    name: 'account UUID',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    note: 'list/item ids identify the account — use <listId> / <lineId> placeholders',
  },
  {
    name: 'absolute home path',
    pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+/g,
    note: 'leaks a local username in a public repo — use /path/to/HEBshopping',
  },
];

/** Paths that legitimately contain hash-like or id-like strings. */
const SKIP = [/package-lock\.json$/, /^\.gitignore$/, /^tools\/scan-secrets\.ts$/, /\.tsbuildinfo$/];

function committableFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
    encoding: 'utf8',
  });

  // `git ls-files -c` still lists a tracked file that has been deleted from the working
  // tree, and the staged-path query excludes deletions — so without this, every commit
  // that removes a file reports an unreadable path and the gate blocks it. A deleted file
  // has no content to leak.
  const deleted = new Set(
    execFileSync('git', ['ls-files', '--deleted'], { encoding: 'utf8' }).split('\n').filter(Boolean),
  );

  return output
    .split('\n')
    .filter(Boolean)
    .filter((path) => !deleted.has(path))
    .filter((path) => !SKIP.some((skip) => skip.test(path)));
}

/** Paths git has staged, i.e. the ones whose *index* content is what gets committed. */
function stagedPaths(): Set<string> {
  try {
    const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      encoding: 'utf8',
    });
    return new Set(output.split('\n').filter(Boolean));
  } catch {
    return new Set(); // no HEAD yet, or not a repo — fall back to working-tree content
  }
}

/**
 * The content that would actually be committed.
 *
 * As a pre-commit gate, reading the working tree is the wrong thing: a secret can be
 * staged and then deleted from disk, and the scan would pass while the staged blob still
 * carries the credential into the commit. For staged paths, read the blob from the index;
 * for everything else — untracked files, unstaged edits — the working tree is what a later
 * `git add -A` would pick up, so read that.
 */
function contentToScan(path: string, staged: ReadonlySet<string>): string | null {
  if (staged.has(path)) {
    try {
      return execFileSync('git', ['show', `:${path}`], {
        encoding: 'utf8',
        maxBuffer: MAX_SCAN_BYTES,
      });
    } catch {
      return null;
    }
  }

  try {
    if (statSync(path).size > MAX_SCAN_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Files this gate could not read.
 *
 * Silently skipping them is the one failure mode a secret scanner must not have: a large
 * capture full of live cookies is *exactly* the file that trips a size limit, and reporting
 * "no secrets found" over it is worse than not running at all. Unreadable is treated as
 * unproven, and unproven fails the gate.
 */
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const unscanned: string[] = [];

let findings = 0;
const staged = stagedPaths();

for (const path of committableFiles()) {
  const content = contentToScan(path, staged);
  if (content === null) {
    unscanned.push(path);
    continue;
  }

  for (const rule of RULES) {
    for (const match of content.matchAll(rule.pattern)) {
      const line = content.slice(0, match.index).split('\n').length;
      // Location and rule only. Echoing even a prefix of the match would write a complete
      // AWS key, or a usable chunk of a cookie, into terminal scrollback and CI logs —
      // spreading the credential this tool exists to contain.
      console.error(`✗ ${path}:${line}  [${rule.name}] ${match[0].length} chars, not shown`);
      console.error(`    ${rule.note}`);
      findings += 1;
    }
  }
}

if (unscanned.length > 0) {
  console.error(`\n⛔ ${unscanned.length} committable file(s) could not be inspected:`);
  for (const path of unscanned) console.error(`   ${path}`);
  console.error('   A scanner that skips files cannot certify them. Exclude them via');
  console.error('   .gitignore if they do not belong in the repo, or make them readable.');
  process.exit(1);
}

if (findings > 0) {
  console.error(`\n${findings} finding(s). Nothing above should be committed.`);
  process.exit(1);
}

console.log(`✓ No secrets or account identifiers in ${committableFiles().length} committable files.`);
