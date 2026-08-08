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
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';

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
    //
    // JSON object key order is not significant, so a captured or reserialised jar can put
    // `value` before `name`, or another field like `domain` between them. `[^{}]*?` matches
    // any such in-between fields without crossing into a neighbouring object, so both key
    // orders are caught either way.
    //
    // A fixture pasted as a JS/TS object literal rather than strict JSON drops the quotes
    // around keys and may use single quotes for either the keys or the values —
    // `["']?name["']?` allows the key to be bare, double- or single-quoted, and `["'](…)["']`
    // does the same for the value, so those object literals are caught too.
    name: 'serialised cookie jar',
    pattern:
      /["']?name["']?\s*:\s*["'](?:reese84|sat|sst|sst\.sig|_session[^"']*|visid_incap_\d+)["'][^{}]*?["']?value["']?\s*:\s*["'][^"']{16,}["']|["']?value["']?\s*:\s*["'][^"']{16,}["'][^{}]*?["']?name["']?\s*:\s*["'](?:reese84|sat|sst|sst\.sig|_session[^"']*|visid_incap_\d+)["']/g,
    note: 'live credential in JSON/JS-object form — this is what a session/storage-state file looks like',
  },
  {
    name: 'bearer token',
    pattern: /\bbearer\s+[A-Za-z0-9._-]{20,}/gi,
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
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    note: 'list/item ids identify the account — use <listId> / <lineId> placeholders',
  },
  {
    name: 'absolute home path',
    pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+/g,
    note: 'leaks a local username in a public repo — use /path/to/HEBshopping',
  },
  {
    // H-E-B store numbers pin a household to an approximate location, same category of
    // finding as the account UUID rule above. Keyed off the field name — a bare three-digit
    // number matches too much generic content otherwise.
    name: 'store number',
    pattern: /["']?store(?:Number|Id)["']?\s*:\s*["']?\d{2,5}["']?/gi,
    note: 'store number/id identifies the account’s location — use <storeNumber> placeholder',
  },
  // Not a secret or PII, unlike everything above — a regression guard riding this same gate
  // because it is the one that already runs on every commit. "grocery list", "heb list" and
  // "heb cart" are invocation names measured (docs/deploy.md's table) to collide with an
  // Alexa built-in feature and silently never reach this skill; "house list" was the second
  // skill's name from the same family. All were renamed away, and the rename took four
  // review rounds to fully land — a stale doc or leftover example resurrecting one is the
  // exact bug this scanner is now cheap insurance against.
  //
  // Scoped to how the name actually surfaces — after "ask" or "open" as a spoken example, in
  // an "invocation name is" declaration, or as the interaction model's own field — rather
  // than the bare words, which also appear constantly as ordinary prose ("your H-E-B grocery
  // list") unrelated to the invocation-name bug. "open" is its own invocation form (see
  // docs/deploy.md's "open heb shopper" row) and routes a retired name to the same Alexa
  // built-in as "ask" does.
  {
    name: 'retired invocation name (spoken example)',
    pattern: /\b(?:ask|open)\s+(?:the\s+|my\s+)?(?:grocery list|heb list|heb cart|house list)\b/gi,
    note: 'renamed away after colliding with an Alexa built-in — see the table in docs/deploy.md',
  },
  {
    // `[\s\S]{0,30}` (not `[^\n]{0,30}`) and `\s+` (not a literal space) so a name that
    // Markdown line-wrapped across the gap — e.g. `invocation name is **"grocery\nlist"**`,
    // which is exactly how this line once read — still matches instead of sailing through.
    name: 'retired invocation name (declared)',
    pattern: /invocation name[\s\S]{0,30}(?:grocery\s+list|heb\s+list|heb\s+cart|house\s+list)/gi,
    note: 'renamed away after colliding with an Alexa built-in — see the table in docs/deploy.md',
  },
  {
    name: 'retired invocation name (interaction model)',
    pattern: /"invocationName"\s*:\s*"(?:grocery list|heb list|heb cart|house list)"/gi,
    note: 'renamed away after colliding with an Alexa built-in — see the table in docs/deploy.md',
  },
];

/** Paths that legitimately contain hash-like or id-like strings. */
const SKIP = [/^tools\/scan-secrets\.ts$/, /\.tsbuildinfo$/];

function committableFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
    encoding: 'utf8',
  });

  // Only *index* deletions are skipped — paths git has actually been told to remove.
  //
  // `git ls-files --deleted` is the wrong question: it reports anything missing from the
  // working tree, including a file that was staged *with a secret in it* and then deleted
  // from disk. Skipping those would let the staged blob sail through the gate unread,
  // which is the precise failure this scanner exists to prevent. A file whose deletion is
  // staged has no content to leak; a file merely missing from disk may still have plenty.
  const deleted = new Set(
    execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=D'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean),
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
    // ACMR alone misses type changes (`T`): a tracked symlink staged as a regular file, or
    // vice versa, carries whatever content is in the new staged blob and is exactly the kind
    // of path this scanner exists to read from the index rather than the worktree.
    const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRT'], {
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
    // A symlink's committed content is the link-target string, not the file it points to —
    // `statSync`/`readFileSync` follow the link and would scan the target's contents instead,
    // missing a target path like "/home/alice/session.json" baked into the committed blob.
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return readlinkSync(path);
    if (stat.size > MAX_SCAN_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Paths whose removal is staged; their content cannot reach the commit. */

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
  // The path itself is committed content too — a fixture named for a real line UUID or an
  // email address leaks the identifier even when the file's contents are clean.
  for (const rule of RULES) {
    for (const match of path.matchAll(rule.pattern)) {
      console.error(`✗ ${path}  [${rule.name} in path] ${match[0].length} chars, not shown`);
      console.error(`    ${rule.note}`);
      findings += 1;
    }
  }

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
