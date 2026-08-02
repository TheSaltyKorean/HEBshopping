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
    pattern: /\b(reese84|sat|sst|_session|visid_incap_\d+)\s*=\s*[A-Za-z0-9%_.+/-]{16,}/g,
    note: 'live credential — rotate immediately if this ever reached a remote',
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
  return output
    .split('\n')
    .filter(Boolean)
    .filter((path) => !SKIP.some((skip) => skip.test(path)));
}

let findings = 0;

for (const path of committableFiles()) {
  let content: string;
  try {
    if (statSync(path).size > 2_000_000) continue;
    content = readFileSync(path, 'utf8');
  } catch {
    continue; // binary or unreadable
  }

  for (const rule of RULES) {
    for (const match of content.matchAll(rule.pattern)) {
      const line = content.slice(0, match.index).split('\n').length;
      const preview = match[0].slice(0, 48);
      console.error(`✗ ${path}:${line}  [${rule.name}] ${preview}`);
      console.error(`    ${rule.note}`);
      findings += 1;
    }
  }
}

if (findings > 0) {
  console.error(`\n${findings} finding(s). Nothing above should be committed.`);
  process.exit(1);
}

console.log(`✓ No secrets or account identifiers in ${committableFiles().length} committable files.`);
