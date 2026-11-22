// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Positions where O occurs in lines at the given tier (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * First tier (0..2) at which O occurs at least once at or after `from`, with its
 * positions; null when O occurs at no tier. With --strict only tier 0 is tried.
 */
function findTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    const pos = occurrences(lines, o, t).filter((i) => i >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of a replacement: a context line (oIndex: its index in O) or a new line. */
interface NewLine {
  text: string;
  oIndex: number | null;
}

/**
 * The lines N writes when it replaces O matched at `at` (section 5): context lines
 * are the file's own matched lines; at tier 2 every other non-blank line that starts
 * with O's first line's leading whitespace has that prefix swapped for the file's.
 */
function buildReplacement(fileLines: string[], at: number, o: string[], n: NewLine[], tier: number): string[] {
  const out: string[] = [];
  for (const e of n) {
    if (e.oIndex !== null) {
      out.push(fileLines[at + e.oIndex]!);
      continue;
    }
    if (tier === 2 && o.length > 0) {
      const p = leadWs(o[0]!);
      const f = leadWs(fileLines[at] ?? '');
      const t = e.text;
      if (t !== '' && t.trim() !== '' && p !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else if (t !== '' && t.trim() !== '' && p === '') out.push(f + t);
      else out.push(t);
    } else {
      out.push(e.text);
    }
  }
  return out;
}

/** A file an edit creates from lines: LF breaks, ending with one unless empty. */
function createdFile(lines: string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, so the output can print `R old -> new` lines. */
  readonly moves: { old: string; nw: string }[] = [];
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
  /** True when the path holds a file in the tree as earlier edits left it, or any
   * filesystem entry (a directory counts as existing for a create/move-to check). */
  existsAny(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    if (this.original(p) !== null) return true;
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  }
  /** The file's state, or null when it holds no file. */
  file(p: string): FileState | null {
    const t = this.get(p);
    return t === null ? null : parseFile(t);
  }
  setFile(p: string, f: FileState): void {
    this.now.set(p, serializeFile(f));
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

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

// ---- Unified diffs (SPEC.md section 6) ----

interface UniHunk {
  a: number;
  o: string[];
  n: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEolCtxPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noEolPlus: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UniHunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path a `--- ` / `+++ ` line names (`/dev/null` is no file). */
function uniHeaderPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let headerDone = false;
  let pairSeen = false;
  let gitOld: string | null = null;
  let gitNew: string | null = null;
  let pairOld: string | null | undefined = undefined;
  let pairNew: string | null | undefined = undefined;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let newFileMode = false;
  let deletedFileMode = false;

  const finishSection = (): void => {
    if (cur === null) return;
    const oldP = pairOld !== undefined ? pairOld : (renameFrom ?? gitOld);
    const newP = pairNew !== undefined ? pairNew : (renameTo ?? gitNew);
    cur.oldPath = oldP;
    cur.newPath = newP;
    cur.isCreate = newFileMode || oldP === null;
    cur.isDelete = !cur.isCreate && (deletedFileMode || newP === null);
    sections.push(cur);
    cur = null;
  };
  const openSection = (gOld: string | null, gNew: string | null): void => {
    finishSection();
    cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
    headerDone = false;
    pairSeen = false;
    gitOld = gOld;
    gitNew = gNew;
    pairOld = undefined;
    pairNew = undefined;
    renameFrom = null;
    renameTo = null;
    newFileMode = false;
    deletedFileMode = false;
  };
  const takePair = (i: number): void => {
    pairOld = uniHeaderPath(lines[i]!);
    pairNew = uniHeaderPath(lines[i + 1]!);
    pairSeen = true;
  };

  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    const isGit = line.startsWith('diff --git ');
    const isPair = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (isGit) {
      const m = DIFF_GIT.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      openSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (cur === null) {
      if (isPair) {
        openSection(null, null);
        takePair(i);
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (isPair && (headerDone || pairSeen)) {
      openSection(null, null);
      takePair(i);
      i += 2;
      continue;
    }
    if (isPair && !headerDone && !pairSeen) {
      takePair(i);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const body: string[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const o: string[] = [];
      const nn: NewLine[] = [];
      let lastCtxPlus = -1;
      let lastPlus = -1;
      body.forEach((bl, bi) => {
        if (bl === '' || bl.startsWith(' ')) {
          const text = bl === '' ? '' : bl.slice(1);
          o.push(text);
          nn.push({ text, oIndex: o.length - 1 });
          lastCtxPlus = bi;
        } else if (bl.startsWith('-')) {
          o.push(bl.slice(1));
        } else if (bl.startsWith('+')) {
          nn.push({ text: bl.slice(1), oIndex: null });
          lastCtxPlus = bi;
          lastPlus = bi;
        }
      });
      const noEolCtxPlus = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
      const noEolPlus = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
      cur.hunks.push({ a, o, n: nn, noEolCtxPlus, noEolPlus });
      headerDone = true;
      continue;
    }
    if (!headerDone) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        if (pairNew === undefined) pairNew = uniHeaderPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (renameFrom === null) renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (renameTo === null) renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        newFileMode = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        deletedFileMode = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  finishSection();

  return sections.map((sec) => (tree: Tree): void => applyUniSection(tree, sec, strict));
}

/** Apply a section's hunks in order to a file state, tracking the line drift d. */
function applyHunks(st: FileState, hunks: UniHunk[], strict: boolean, path: string): FileState {
  const lines = [...st.lines];
  let final = st.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), lines.length);
      const texts = h.n.map((e) => e.text);
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...texts);
      if (atEnd) final = !h.noEolCtxPlus;
      d += h.n.length;
      continue;
    }
    const found = findTier(lines, h.o, 0, strict);
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
    const atEnd = best + h.o.length === lines.length;
    const repl = buildReplacement(lines, best, h.o, h.n, found.tier);
    lines.splice(best, h.o.length, ...repl);
    if (atEnd) final = !h.noEolCtxPlus;
    d += h.n.length - h.o.length;
  }
  return { lines, br: st.br, final };
}

function applyUniSection(tree: Tree, sec: UniSection, strict: boolean): void {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
  if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
  if (sec.isCreate) {
    if (newP === null) throw new Fail('unsafe', '');
    if (tree.existsAny(newP)) throw new Fail('exists', newP);
    const plus: string[] = [];
    let lastNoEol = false;
    let anyPlus = false;
    for (const h of sec.hunks) {
      for (const e of h.n) {
        if (e.oIndex === null) {
          plus.push(e.text);
          anyPlus = true;
          lastNoEol = h.noEolPlus;
        }
      }
    }
    tree.now.set(newP, anyPlus ? plus.join('\n') + (lastNoEol ? '' : '\n') : '');
    return;
  }
  if (sec.isDelete) {
    if (oldP === null) throw new Fail('unsafe', '');
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, null);
    return;
  }
  const from = oldP!;
  const to = newP!;
  const before = tree.file(from);
  if (before === null) throw new Fail('missing', from);
  const isMove = from !== to;
  if (isMove && tree.existsAny(to)) throw new Fail('exists', to);
  const st = applyHunks(before, sec.hunks, strict, from);
  if (isMove) {
    tree.now.set(from, null);
    tree.now.set(to, serializeFile(st));
    tree.moves.push({ old: from, nw: to });
  } else {
    tree.now.set(from, serializeFile(st));
  }
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new Exit2(`error: parse ${searchLine}`);
    }
    let k = i + 1;
    let sep = -1;
    while (k < n) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchLine}`);
      k += 1;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let m = sep + 1;
    let end = -1;
    while (m < n) {
      if (lines[m]!.trimEnd() === '>>>>>>> REPLACE') {
        end = m;
        break;
      }
      m += 1;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevEnd = end + 1;
    i = end + 1;
  }
  return blocks.map((b) => (tree: Tree): void => applySRBlock(tree, b, strict));
}

function applySRBlock(tree: Tree, b: SRBlock, strict: boolean): void {
  if (!safe(b.path)) throw new Fail('unsafe', b.path);
  if (b.oldLines.length === 0) {
    if (tree.existsAny(b.path)) throw new Fail('exists', b.path);
    tree.now.set(b.path, createdFile(b.newLines));
    return;
  }
  const before = tree.file(b.path);
  if (before === null) throw new Fail('missing', b.path);
  const found = findTier(before.lines, b.oldLines, 0, strict);
  if (found === null) throw new Fail('no-match', b.path);
  if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
  const at = found.pos[0]!;
  const n: NewLine[] = b.newLines.map((t) => ({ text: t, oIndex: null }));
  const repl = buildReplacement(before.lines, at, b.oldLines, n, found.tier);
  const lines = [...before.lines];
  lines.splice(at, b.oldLines.length, ...repl);
  tree.setFile(b.path, { lines, br: before.br, final: before.final });
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  /** Null: no anchor. */
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: VChunk[];
  addLines: string[];
  line: number;
}

function v4aSectionStart(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  for (const [prefix, kind] of [
    ['*** Add File:', 'add'],
    ['*** Delete File:', 'delete'],
    ['*** Update File:', 'update'],
  ] as const) {
    if (line.startsWith(prefix)) return { kind, path: line.slice(prefix.length).trim() };
  }
  return null;
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const start = v4aSectionStart(lines[i]!);
    if (start === null) throw new Exit2(`error: parse ${i + 1}`);
    const sectionLine = i + 1;
    i += 1;
    const raw: string[] = [];
    while (i < last && v4aSectionStart(lines[i]!) === null) {
      raw.push(lines[i]!);
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const sec: VSection = { kind: start.kind, path: start.path, moveTo: null, chunks: [], addLines: [], line: sectionLine };
    if (start.kind === 'add') {
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l === '') sec.addLines.push('');
        else if (l.startsWith('+')) sec.addLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${sectionLine + 1 + k}`);
      }
    } else if (start.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${sectionLine + 1}`);
    } else {
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to:')) {
        sec.moveTo = raw[0]!.slice('*** Move to:'.length).trim();
        k = 1;
      }
      let chunk: VChunk | null = null;
      let seenBody = false;
      const openChunk = (anchor: string | null): void => {
        chunk = { anchor, eof: false, o: [], n: [] };
        sec.chunks.push(chunk);
      };
      for (; k < raw.length; k += 1) {
        const l = raw[k]!;
        const at = sectionLine + 1 + k;
        if (l.startsWith('@@')) {
          openChunk(l.slice(2).trim() === '' ? null : l.slice(2).trim());
          seenBody = true;
          continue;
        }
        if (l.trimEnd() === '*** End of File') {
          if (chunk === null) openChunk(null);
          chunk!.eof = true;
          chunk = null;
          seenBody = true;
          continue;
        }
        if (blank(l)) {
          if (chunk !== null) {
            chunk.o.push('');
            chunk.n.push({ text: '', oIndex: chunk.o.length - 1 });
          }
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (chunk === null) {
            if (seenBody) throw new Exit2(`error: parse ${at}`);
            openChunk(null);
          }
          seenBody = true;
          if (l.startsWith(' ')) {
            const text = l.slice(1);
            chunk!.o.push(text);
            chunk!.n.push({ text, oIndex: chunk!.o.length - 1 });
          } else if (l.startsWith('-')) {
            chunk!.o.push(l.slice(1));
          } else {
            chunk!.n.push({ text: l.slice(1), oIndex: null });
          }
          continue;
        }
        throw new Exit2(`error: parse ${at}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
    }
    sections.push(sec);
  }
  return sections.map((sec) => (tree: Tree): void => applyV4ASection(tree, sec, strict));
}

function applyV4ASection(tree: Tree, sec: VSection, strict: boolean): void {
  if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
  if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
  if (sec.kind === 'add') {
    if (tree.existsAny(sec.path)) throw new Fail('exists', sec.path);
    tree.now.set(sec.path, createdFile(sec.addLines));
    return;
  }
  if (sec.kind === 'delete') {
    if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
    tree.now.set(sec.path, null);
    return;
  }
  const before = tree.file(sec.path);
  if (before === null) throw new Fail('missing', sec.path);
  if (sec.moveTo !== null && tree.existsAny(sec.moveTo)) throw new Fail('exists', sec.moveTo);
  const lines = [...before.lines];
  let cursor = 0;
  for (const ch of sec.chunks) {
    if (ch.anchor !== null) {
      let foundAt = -1;
      const max = strict ? 0 : 2;
      for (let t = 0; t <= max && foundAt < 0; t += 1) {
        for (let j = cursor; j < lines.length; j += 1) {
          if (lineEq(lines[j]!, ch.anchor, t)) {
            foundAt = j;
            break;
          }
        }
      }
      if (foundAt < 0) throw new Fail('no-match', sec.path);
      cursor = foundAt + 1;
    }
    if (ch.o.length === 0) {
      const pos = ch.eof ? lines.length : cursor;
      const texts = ch.n.map((e) => e.text);
      lines.splice(pos, 0, ...texts);
      cursor = pos + texts.length;
      continue;
    }
    const found = findTier(lines, ch.o, cursor, strict);
    if (found === null) throw new Fail('no-match', sec.path);
    const at = ch.eof ? found.pos.filter((p) => p + ch.o.length === lines.length)[0] : found.pos[0];
    if (at === undefined) throw new Fail('no-match', sec.path);
    const repl = buildReplacement(lines, at, ch.o, ch.n, found.tier);
    lines.splice(at, ch.o.length, ...repl);
    cursor = at + repl.length;
  }
  const out: FileState = { lines, br: before.br, final: before.final };
  if (sec.moveTo !== null) {
    tree.now.set(sec.path, null);
    tree.now.set(sec.moveTo, serializeFile(out));
    tree.moves.push({ old: sec.path, nw: sec.moveTo });
  } else {
    tree.now.set(sec.path, serializeFile(out));
  }
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.nw);
    const nowNew = tree.get(m.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      covered.add(m.old);
      covered.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out: string[] = [];
  for (const r of rows) {
    out.push(r.line);
    if (check) continue;
    const p = r.line.startsWith('R ') ? r.line.slice(2).split(' -> ')[1]! : r.line.slice(2);
    const now = tree.now.get(p);
    if (r.line.startsWith('R ')) {
      const old = r.line.slice(2).split(' -> ')[0]!;
      rmSync(old, { force: true });
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now!);
    } else if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...out, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
