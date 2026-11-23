// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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

/* ---------- shared line matching (SPEC.md sections 3 and 5) ---------- */

interface FileLines {
  br: string;
  lines: string[];
  fin: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], fin: false };
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { br, lines, fin };
}

function joinFile(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.fin ? f.br : '');
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

interface Found {
  tier: number;
  positions: number[];
}

/** Occurrences of O in fileLines at the first tier that has one, at or after `from`. */
function findTier(fileLines: string[], O: string[], strict: boolean, from = 0, mustEnd = false): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= fileLines.length; i += 1) {
      if (mustEnd && i + O.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (normLine(fileLines[i + j]!, tier) !== normLine(O[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function reindent(s: string, F: string, P: string): string {
  if (s !== '' && s.trim() !== '' && s.startsWith(P)) return F + s.slice(P.length);
  return s;
}

type Entry = { t: 'c' | 'd' | 'a'; s: string; noeol?: boolean; rawEmpty?: boolean };

/** The lines a matched hunk/chunk writes: context lines are the file's own, adds re-indent at tier 2. */
function buildSeg(fileLines: string[], pos: number, entries: Entry[], tier: number, O: string[]): string[] {
  const out: string[] = [];
  const F = leadWs(fileLines[pos] ?? '');
  const P = leadWs(O[0] ?? '');
  let oi = 0;
  for (const e of entries) {
    if (e.t === 'd') oi += 1;
    else if (e.t === 'c') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else out.push(tier === 2 ? reindent(e.s, F, P) : e.s);
  }
  return out;
}

/** Plain replacement (SEARCH/REPLACE): every new line is subject to the tier-2 re-indent. */
function buildPlain(fileLines: string[], pos: number, O: string[], N: string[], tier: number): string[] {
  const F = leadWs(fileLines[pos] ?? '');
  const P = leadWs(O[0] ?? '');
  return tier === 2 ? N.map((s) => reindent(s, F, P)) : [...N];
}

function needSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

function needFile(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

/* ---------- unified diffs (section 6) ---------- */

interface UHunk {
  A: number;
  entries: Entry[];
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  oldPath?: string;
  newPath?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  pair: boolean;
  hunks: UHunk[];
}

function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let inHeader = false;
  let hunk: UHunk | null = null;
  const endHunk = (): void => {
    if (hunk !== null) {
      while (hunk.entries.length > 0 && hunk.entries[hunk.entries.length - 1]!.rawEmpty) hunk.entries.pop();
      hunk = null;
    }
  };
  const newSection = (): USection => {
    endHunk();
    sec = { newFile: false, delFile: false, pair: false, hunks: [] };
    sections.push(sec);
    inHeader = true;
    return sec;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const pairStart = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    const gitStart = line.startsWith('diff --git ');
    if (hunk !== null) {
      const isBody = line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\');
      if (!gitStart && !pairStart && !line.startsWith('@@') && isBody) {
        if (line.startsWith('\\')) {
          const last = hunk.entries[hunk.entries.length - 1];
          if (last !== undefined) last.noeol = true;
        } else if (line === '') hunk.entries.push({ t: 'c', s: '', rawEmpty: true });
        else hunk.entries.push({ t: line.startsWith(' ') ? 'c' : line.startsWith('-') ? 'd' : 'a', s: line.slice(1) });
        i += 1;
        continue;
      }
      endHunk();
    }
    if (gitStart) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (pairStart) {
      if (sec !== null && inHeader && !sec.pair) {
        sec.oldPath = headerPath(line);
        sec.newPath = headerPath(lines[i + 1]!);
        sec.pair = true;
      } else {
        const s = newSection();
        s.oldPath = headerPath(line);
        s.newPath = headerPath(lines[i + 1]!);
        s.pair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { A: Number(m[1]), entries: [] };
      sec.hunks.push(hunk);
      inHeader = false;
      i += 1;
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  endHunk();

  const applyHunks = (text: string, hunks: UHunk[], path: string): string => {
    const f = splitFile(text);
    const ls = [...f.lines];
    let fin = f.fin;
    let d = 0;
    for (const h of hunks) {
      const O = h.entries.filter((e) => e.t !== 'a').map((e) => e.s);
      const N = h.entries.filter((e) => e.t !== 'd');
      if (O.length === 0) {
        const pos = Math.min(h.A + d, ls.length);
        const ins = N.map((e) => e.s);
        const atEnd = pos === ls.length;
        ls.splice(pos, 0, ...ins);
        if (atEnd && ins.length > 0) fin = !N[N.length - 1]!.noeol;
        d += ins.length;
      } else {
        const found = findTier(ls, O, strict);
        if (found === null) throw new Fail('no-match', path);
        const target = h.A - 1 + d;
        let pos = found.positions[0]!;
        for (const p of found.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
        const seg = buildSeg(ls, pos, h.entries, found.tier, O);
        const runsEnd = pos + O.length === ls.length;
        ls.splice(pos, O.length, ...seg);
        if (runsEnd) {
          if (N.length > 0) fin = !N[N.length - 1]!.noeol;
          else fin = ls.length > 0;
        }
        d += N.length - O.length;
      }
    }
    return joinFile({ br: f.br, lines: ls, fin });
  };

  return sections.map((s) => {
    const oldP = s.oldPath ?? s.renameFrom ?? s.gitOld;
    const newP = s.newPath ?? s.renameTo ?? s.gitNew;
    const isCreate = s.oldPath === '/dev/null' || s.newFile;
    const isDelete = s.newPath === '/dev/null' || s.delFile;
    return (tree: Tree): void => {
      if (isCreate) {
        const p = newP!;
        needSafe(p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus = s.hunks.flatMap((h) => h.entries.filter((e) => e.t === 'a'));
        const ls = plus.map((e) => e.s);
        tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + (!plus[plus.length - 1]!.noeol ? '\n' : ''));
        return;
      }
      if (isDelete) {
        const p = oldP!;
        needSafe(p);
        needFile(tree, p);
        tree.now.set(p, null);
        return;
      }
      if (oldP !== undefined && newP !== undefined && oldP !== newP) {
        needSafe(oldP);
        needSafe(newP);
        const before = needFile(tree, oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        tree.now.set(newP, applyHunks(before, s.hunks, oldP));
        tree.now.set(oldP, null);
        tree.moves.push([oldP, newP]);
        return;
      }
      const p = (oldP ?? newP)!;
      needSafe(p);
      const before = needFile(tree, p);
      tree.now.set(p, applyHunks(before, s.hunks, p));
    };
  });
}

/* ---------- SEARCH/REPLACE blocks (section 7) ---------- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldL: string[];
    newL: string[];
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    let rep = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') eq = j;
      else if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({ path, oldL: lines.slice(searchLine + 1, eq), newL: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree): void => {
    needSafe(b.path);
    if (b.oldL.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newL.length === 0 ? '' : b.newL.join('\n') + '\n');
      return;
    }
    const before = needFile(tree, b.path);
    const f = splitFile(before);
    const found = findTier(f.lines, b.oldL, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const ls = [...f.lines];
    ls.splice(pos, b.oldL.length, ...buildPlain(ls, pos, b.oldL, b.newL, found.tier));
    tree.now.set(b.path, joinFile({ br: f.br, lines: ls, fin: f.fin }));
  });
}

/* ---------- V4A patches (section 8) ---------- */

interface VChunk {
  anchor: string | null;
  entries: Entry[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface VSection {
    kind: 'add' | 'del' | 'upd';
    path: string;
    startLine: number;
    content: { line: string; n: number }[];
  }
  const sections: VSection[] = [];
  const secStart = (l: string): { kind: VSection['kind']; path: string } | null => {
    if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice(14).trim() };
    if (l.startsWith('*** Delete File: ')) return { kind: 'del', path: l.slice(17).trim() };
    if (l.startsWith('*** Update File: ')) return { kind: 'upd', path: l.slice(17).trim() };
    return null;
  };
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const st = secStart(l);
    if (st === null) throw new Exit2(`error: parse ${i + 1}`);
    const content: VSection['content'] = [];
    let j = i + 1;
    while (j < last && secStart(lines[j]!) === null) {
      content.push({ line: lines[j]!, n: j + 1 });
      j += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.line)) content.pop();
    sections.push({ kind: st.kind, path: st.path, startLine: i + 1, content });
    i = j;
  }

  const parseChunks = (s: VSection): { moveTo: string | null; chunks: VChunk[] } => {
    let moveTo: string | null = null;
    let rest = s.content;
    if (rest.length > 0 && rest[0]!.line.startsWith('*** Move to: ')) {
      moveTo = rest[0]!.line.slice(13).trim();
      rest = rest.slice(1);
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    for (const { line, n } of rest) {
      if (line.startsWith('@@')) {
        cur = { anchor: line.slice(2).trim() === '' ? null : line.slice(2).trim(), entries: [], eof: false };
        chunks.push(cur);
      } else if (line.trim() === '*** End of File' && !line.startsWith(' ')) {
        if (cur === null) {
          cur = { anchor: null, entries: [], eof: true };
          chunks.push(cur);
        } else cur.eof = true;
        cur = null;
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
        if (cur === null) {
          cur = { anchor: null, entries: [], eof: false };
          chunks.push(cur);
        }
        if (line === '') cur.entries.push({ t: 'c', s: '' });
        else cur.entries.push({ t: line.startsWith(' ') ? 'c' : line.startsWith('-') ? 'd' : 'a', s: line.slice(1) });
      } else throw new Exit2(`error: parse ${n}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.startLine}`);
    return { moveTo, chunks };
  };

  return sections.map((s) => {
    if (s.kind === 'add') {
      const fileLines: string[] = [];
      for (const { line, n } of s.content) {
        if (line.startsWith('+')) fileLines.push(line.slice(1));
        else if (line === '') fileLines.push('');
        else throw new Exit2(`error: parse ${n}`);
      }
      return (tree: Tree): void => {
        needSafe(s.path);
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      };
    }
    if (s.kind === 'del') {
      if (s.content.length > 0) throw new Exit2(`error: parse ${s.content[0]!.n}`);
      return (tree: Tree): void => {
        needSafe(s.path);
        needFile(tree, s.path);
        tree.now.set(s.path, null);
      };
    }
    const { moveTo, chunks } = parseChunks(s);
    return (tree: Tree): void => {
      needSafe(s.path);
      if (moveTo !== null) needSafe(moveTo);
      const before = needFile(tree, s.path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const f = splitFile(before);
      const ls = [...f.lines];
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const tiers = strict ? [0] : [0, 1, 2];
          let at = -1;
          for (const tier of tiers) {
            for (let k = cursor; k < ls.length; k += 1) {
              if (normLine(ls[k]!, tier) === normLine(ch.anchor, tier)) {
                at = k;
                break;
              }
            }
            if (at >= 0) break;
          }
          if (at < 0) throw new Fail('no-match', s.path);
          cursor = at + 1;
        }
        const O = ch.entries.filter((e) => e.t !== 'a').map((e) => e.s);
        const N = ch.entries.filter((e) => e.t !== 'd');
        if (O.length === 0) {
          const pos = ch.eof ? ls.length : Math.min(cursor, ls.length);
          const ins = N.map((e) => e.s);
          ls.splice(pos, 0, ...ins);
          cursor = pos + ins.length;
        } else {
          const found = findTier(ls, O, strict, cursor, ch.eof);
          if (found === null) throw new Fail('no-match', s.path);
          const pos = found.positions[0]!;
          const seg = buildSeg(ls, pos, ch.entries, found.tier, O);
          ls.splice(pos, O.length, ...seg);
          cursor = pos + seg.length;
        }
      }
      const text = joinFile({ br: f.br, lines: ls, fin: f.fin });
      if (moveTo !== null) {
        tree.now.set(moveTo, text);
        tree.now.set(s.path, null);
        tree.moves.push([s.path, moveTo]);
      } else tree.now.set(s.path, text);
    };
  });
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
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
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
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) != null) {
      movedOld.add(o);
      movedNew.add(n);
      rows.push({ key: n, text: `R ${o} -> ${n}` });
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!movedOld.has(p) && !movedNew.has(p)) rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
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
