// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. SPEC.md is the contract.
//
// Node 22, standard library alone. Run as: node main.ts [options] [PATCH]
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Exit 2 with exactly one line on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const byteCompare = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** One file as lines: its line break, its lines, and whether it ends with a break. */
interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}

function writeDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A line as a tier sees it: tier 0 exact, tier 1 trailing spaces/tabs off, tier 2 both ends off. */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occursAt(lines: string[], old: string[], tier: number, at: number): boolean {
  for (let k = 0; k < old.length; k++) {
    if (norm(lines[at + k]!, tier) !== norm(old[k]!, tier)) return false;
  }
  return true;
}

function findOccurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= lines.length; i++) {
    if (occursAt(lines, old, tier, i)) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which old occurs at or after `from`. */
function findTier(
  lines: string[],
  old: string[],
  strict: boolean,
  from: number,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = findOccurrences(lines, old, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of a replacement: a context line names its index in the old lines, else it is new. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/**
 * The lines a replacement writes. Context lines are the file's own matched
 * lines. At tier 2 every other non-empty, non-whitespace line that starts
 * with the old first line's leading whitespace has that whitespace replaced
 * by the file's first matched line's leading whitespace.
 */
function buildNew(
  old: string[],
  next: NewLine[],
  fileLines: string[],
  at: number,
  tier: number,
): string[] {
  const out: string[] = [];
  const f = tier === 2 && old.length > 0 ? leadingWs(fileLines[at]!) : '';
  const p = tier === 2 && old.length > 0 ? leadingWs(old[0]!) : '';
  for (const item of next) {
    if (item.ctx !== null) {
      out.push(fileLines[at + item.ctx]!);
      continue;
    }
    const t = item.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move pairs (old, new) recorded by move edits, chains collapsed. */
  moves: [string, string][] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  setMove(oldP: string, newP: string): void {
    for (let i = 0; i < this.moves.length; i++) {
      if (this.moves[i]![1] === oldP) {
        this.moves[i] = [this.moves[i]![0], newP];
        return;
      }
    }
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

/** The file an edit reads, or its failure when it is unsafe or missing. */
function mustExist(tree: Tree, p: string): string {
  if (!safe(p)) throw new Fail('unsafe', p);
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

/** Detect the patch's format (SPEC.md section 4), or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = mustExist(tree, p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = mustExist(tree, p);
      const doc = parseDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const lines = [...doc.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, writeDoc({ lines, br: doc.br, final: doc.final }));
    };
  }
  return null;
}

/** The edits of a JSON patch: one array, or one edit object a line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface BodyLine {
  ch: string;
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  inHeader: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s|$)/;

/** A unified path: text after `--- ` / `+++ `, up to the first tab, spaces off, one a/ or b/ off. */
function uniPath(raw: string): string {
  const cut = raw.split('\t')[0]!;
  const t = cut.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

/** A hunk's body: lines starting with space, -, + or \, or empty; trailing empty lines are not part of it. */
function parseBody(lines: string[], start: number): { body: BodyLine[]; end: number } {
  const body: BodyLine[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l === '') {
      body.push({ ch: ' ', text: '', raw: '' });
      j += 1;
      continue;
    }
    // A `--- ` line followed by a `+++ ` line ends the body and starts a section.
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      body.push({ ch: c, text: l.slice(1), raw: l });
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  return { body, end: j };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(h: Hunk): boolean {
  for (let i = h.body.length - 1; i >= 0; i--) {
    const ch = h.body[i]!.ch;
    if (ch === ' ' || ch === '+') {
      const next = h.body[i + 1];
      return next !== undefined && next.ch === '\\';
    }
  }
  return false;
}

/** The old and new lines of a hunk body, in body order; context lines name their old index. */
function hunkOldNew(h: Hunk): { old: string[]; next: NewLine[] } {
  const old: string[] = [];
  const next: NewLine[] = [];
  for (const b of h.body) {
    if (b.ch === ' ') {
      old.push(b.text);
      next.push({ text: b.text, ctx: old.length - 1 });
    } else if (b.ch === '-') {
      old.push(b.text);
    } else if (b.ch === '+') {
      next.push({ text: b.text, ctx: null });
    }
  }
  return { old, next };
}

/** The hunks of one section, applied in order to a file's lines. */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  let lines = [...doc.lines];
  let finalBr = doc.final;
  let d = 0;
  for (const h of hunks) {
    const { old: o, next: n } = hunkOldNew(h);
    if (o.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const wasAtEnd = at === lines.length;
      const inserted = n.map((x) => x.text);
      lines.splice(at, 0, ...inserted);
      if (wasAtEnd) finalBr = !backslashAfterLast(h);
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const at = best;
    const rep = buildNew(o, n, lines, at, found.tier);
    const runsToEnd = at + o.length === lines.length;
    lines.splice(at, o.length, ...rep);
    if (runsToEnd) finalBr = !backslashAfterLast(h);
    d += n.length - o.length;
  }
  return { lines, br: doc.br, final: finalBr };
}

function uniSections(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let i = 0;
  const fresh = (): UniSection => ({
    diffOld: null,
    diffNew: null,
    oldPath: null,
    newPath: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    isCreate: false,
    isDelete: false,
    inHeader: true,
    hunks: [],
  });
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !cur.inHeader || cur.hasPair) {
        cur = fresh();
        sections.push(cur);
      }
      // else the pair belongs to the current section's header; fall through
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (cur.inHeader) {
      if (line.startsWith('@@')) {
        const m = HUNK_HEAD.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.inHeader = false;
        const { body, end } = parseBody(lines, i + 1);
        cur.hunks.push({ a: Number(m[1]), body });
        i = end;
        continue;
      }
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = uniPath(line.slice(4));
        cur.newPath = uniPath(lines[i + 1]!.slice(4));
        cur.hasPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, end } = parseBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), body });
      i = end;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Whether a created file ends with a line break: not when a `\` follows its last `+` line. */
function creationFinalBreak(hunks: Hunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const body = hunks[hi]!.body;
    for (let bi = body.length - 1; bi >= 0; bi--) {
      if (body[bi]!.ch === '+') {
        const next = body[bi + 1];
        return !(next !== undefined && next.ch === '\\');
      }
    }
  }
  return true;
}

function uniEdit(section: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = section.hasPair
      ? section.oldPath === '/dev/null'
        ? null
        : section.oldPath
      : (section.renameFrom ?? section.diffOld);
    const newP = section.hasPair
      ? section.newPath === '/dev/null'
        ? null
        : section.newPath
      : (section.renameTo ?? section.diffNew);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const create = section.isCreate || oldP === null;
    const del = section.isDelete || newP === null;
    if (create && newP !== null) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const outLines: string[] = [];
      for (const h of section.hunks) {
        for (const b of h.body) if (b.ch === '+') outLines.push(b.text);
      }
      const finalBr = creationFinalBreak(section.hunks);
      tree.now.set(newP, outLines.length === 0 ? '' : outLines.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    if (del && oldP !== null) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return;
    if (oldP !== newP) {
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(parseDoc(cur), section.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, writeDoc(out));
      tree.setMove(oldP, newP);
      return;
    }
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    const out = applyHunks(parseDoc(cur), section.hunks, strict, oldP);
    tree.now.set(oldP, writeDoc(out));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = uniSections(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => uniEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = parseDoc(cur);
    const found = findTier(doc.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const next: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const rep = buildNew(oldLines, next, doc.lines, at, found.tier);
    const lines = [...doc.lines];
    lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, writeDoc({ lines, br: doc.br, final: doc.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (eq === -1) {
        if (t === '=======') eq = j;
      } else if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq === -1 || rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSectionLine {
  text: string;
  no: number;
}

/** A section's lines up to the next section start or `*** End Patch`. */
function collectV4aSection(
  lines: string[],
  start: number,
  endPatch: number,
): { items: VSectionLine[]; next: number } {
  const items: VSectionLine[] = [];
  let j = start;
  while (j < endPatch) {
    const l = lines[j]!;
    if (
      l.startsWith('*** Add File: ') ||
      l.startsWith('*** Delete File: ') ||
      l.startsWith('*** Update File: ')
    ) {
      break;
    }
    items.push({ text: l, no: j + 1 });
    j += 1;
  }
  return { items, next: j };
}

function stripTrailingBlanks(items: VSectionLine[]): VSectionLine[] {
  let end = items.length;
  while (end > 0 && blank(items[end - 1]!.text)) end -= 1;
  return items.slice(0, end);
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let lines = parseDoc(cur).lines;
    const br = parseDoc(cur).br;
    const finalBr = parseDoc(cur).final;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k++) {
            if (norm(lines[k]!, t) === norm(ch.anchor, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const { old: o, next: n } = hunkOldNew({ a: 0, body: ch.body });
      if (o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const inserted = n.map((x) => x.text);
        lines.splice(at, 0, ...inserted);
        cursor = at + inserted.length;
        continue;
      }
      let found: { tier: number; pos: number[] } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const pos = findOccurrences(lines, o, t, cursor).filter(
          (p) => !ch.eof || p + o.length === lines.length,
        );
        if (pos.length > 0) {
          found = { tier: t, pos };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const at = found.pos[0]!;
      const rep = buildNew(o, n, lines, at, found.tier);
      lines.splice(at, o.length, ...rep);
      cursor = at + rep.length;
    }
    const text = writeDoc({ lines, br, final: finalBr });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.setMove(path, moveTo);
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.*)$/.exec(line)) !== null) {
      const path = m[1]!.trim();
      const { items, next } = collectV4aSection(lines, i + 1, last);
      const content = stripTrailingBlanks(items);
      const fileLines: string[] = [];
      for (const item of content) {
        if (item.text === '') fileLines.push('');
        else if (item.text.startsWith('+')) fileLines.push(item.text.slice(1));
        else throw new Exit2(`error: parse ${item.no}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = next;
      continue;
    }
    if ((m = /^\*\*\* Delete File: (.*)$/.exec(line)) !== null) {
      const path = m[1]!.trim();
      const { items, next } = collectV4aSection(lines, i + 1, last);
      const content = stripTrailingBlanks(items);
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.no}`);
      edits.push(v4aDeleteEdit(path));
      i = next;
      continue;
    }
    if ((m = /^\*\*\* Update File: (.*)$/.exec(line)) !== null) {
      const path = m[1]!.trim();
      const updateNo = i + 1;
      const { items, next } = collectV4aSection(lines, i + 1, last);
      const content = stripTrailingBlanks(items);
      let idx = 0;
      let moveTo: string | null = null;
      if (idx < content.length && content[idx]!.text.startsWith('*** Move to: ')) {
        moveTo = content[idx]!.text.slice('*** Move to: '.length).trim();
        idx += 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let anyChunk = false;
      for (; idx < content.length; idx++) {
        const item = content[idx]!;
        const text = item.text;
        if (text.startsWith('@@')) {
          if (curChunk !== null) chunks.push(curChunk);
          const anchor = text.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          anyChunk = true;
          continue;
        }
        if (text === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${item.no}`);
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
          continue;
        }
        if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
          if (curChunk === null) {
            if (anyChunk) throw new Exit2(`error: parse ${item.no}`);
            curChunk = { anchor: null, eof: false, body: [] };
            anyChunk = true;
          }
          curChunk.body.push({
            ch: text === '' ? ' ' : text[0]!,
            text: text === '' ? '' : text.slice(1),
            raw: text,
          });
          continue;
        }
        throw new Exit2(`error: parse ${item.no}`);
      }
      if (curChunk !== null) chunks.push(curChunk);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* The command line (SPEC.md sections 1, 2 and 10)                     */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCompare)) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
