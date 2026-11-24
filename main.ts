// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON tool calls). Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
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

/** Remove surrounding spaces only (SPEC.md says "spaces" for V4A/unified paths, "whitespace" elsewhere). */
function trimSpaces(s: string): string {
  return s.replace(/^ +/, '').replace(/ +$/, '');
}

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
  /** Successful move edits, as [old, new] pairs, for the R lines of section 2. */
  readonly moves: Array<[string, string]> = [];
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

/** Split a file's text into its line break, its lines, and whether it ends with a break (SPEC section 3). */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

/** Join lines back into a file's text: the break between lines, and a final one exactly when `final`. */
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** Line equality at a matching tier (SPEC section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const rtrim = (s: string): string => s.replace(/[ \t]+$/, '');
  if (tier === 1) return rtrim(a) === rtrim(b);
  const trim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return trim(a) === trim(b);
}

/** Every 0-based position where O occurs in the file's lines at a tier (occurrences may overlap). */
function occurrencesAt(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length) return out;
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(file[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs at least once; strict tries tier 0 only. */
function findMatch(file: string[], o: string[], strict: boolean): { tier: number; occs: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occs = occurrencesAt(file, o, t);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/** The leading spaces and tabs of a line. */
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** One body line of a hunk or chunk: context (in both O and N), old (in O), or new (in N). */
type BodyItem = { kind: 'ctx' | 'old' | 'new'; text: string; bs: boolean };

/** Split body items into O (context + old lines) and N (context + new lines, with context flags). */
function splitBody(items: BodyItem[]): { o: string[]; n: Array<{ text: string; ctx: boolean; fileIdx: number }> } {
  const o: string[] = [];
  const n: Array<{ text: string; ctx: boolean; fileIdx: number }> = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      const idx = o.length;
      o.push(it.text);
      n.push({ text: it.text, ctx: true, fileIdx: idx });
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else {
      n.push({ text: it.text, ctx: false, fileIdx: -1 });
    }
  }
  return { o, n };
}

/**
 * Build the replacement lines for a match at file position `pos`: context lines are written as the
 * file's own matched line; at tier 2 every other line of N that is not blank and starts with P
 * (O's first line's leading whitespace) has that P replaced by F (the file's first matched line's).
 */
function buildNew(file: string[], pos: number, o: string[], n: Array<{ text: string; ctx: boolean; fileIdx: number }>, tier: number): string[] {
  const out: string[] = [];
  const P = o.length > 0 ? leadWs(o[0]!) : '';
  const F = leadWs(file[pos] ?? '');
  for (const e of n) {
    if (e.ctx) { out.push(file[pos + e.fileIdx]!); continue; }
    let t = e.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}

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

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchIdx = i;
    let eqIdx = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eqIdx = j; break; }
    }
    let repIdx = -1;
    if (eqIdx >= 0) {
      for (let j = eqIdx + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { repIdx = j; break; }
      }
    }
    if (eqIdx < 0 || repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const { br, lines: fl, final } = splitFile(before);
      const m = findMatch(fl, oldLines, strict);
      if (m === null) throw new Fail('no-match', p);
      if (m.occs.length > 1) throw new Fail('ambiguous', p);
      const pos = m.occs[0]!;
      const nEnt = newLines.map((t) => ({ text: t, ctx: false, fileIdx: -1 }));
      const rep = buildNew(fl, pos, oldLines, nEnt, m.tier);
      const out = [...fl.slice(0, pos), ...rep, ...fl.slice(pos + oldLines.length)];
      tree.now.set(p, joinFile(out, br, final));
    });
    prevPath = p;
    prevEnd = repIdx + 1;
    i = repIdx + 1;
  }
  return edits;
}

/** V4A patches (SPEC.md section 8). */
type V4AChunk = { anchor: string | null; items: BodyItem[]; eof: boolean };

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j++;
    const content = lines.slice(i + 1, j);
    while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
    if (l.startsWith('*** Add File: ')) {
      const p = trimSpaces(l.slice('*** Add File: '.length));
      const fileLines: string[] = [];
      for (let k = 0; k < content.length; k++) {
        const cl = content[k]!;
        if (cl.startsWith('+')) fileLines.push(cl.slice(1));
        else if (cl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (l.startsWith('*** Delete File: ')) {
      const p = trimSpaces(l.slice('*** Delete File: '.length));
      for (let k = 0; k < content.length; k++) {
        if (!blank(content[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = trimSpaces(l.slice('*** Update File: '.length));
      let moveTo: string | null = null;
      let k = 0;
      while (k < content.length && blank(content[k]!)) k++;
      if (k < content.length && content[k]!.startsWith('*** Move to: ')) {
        moveTo = trimSpaces(content[k]!.slice('*** Move to: '.length));
        k++;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      for (; k < content.length; k++) {
        const cl = content[k]!;
        if (cl.startsWith('@@')) {
          cur = { anchor: trimSpaces(cl.slice(2)), items: [], eof: false };
          chunks.push(cur);
        } else if (cl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 2 + k}`);
          cur.eof = true;
          cur = null;
        } else if (cl.startsWith(' ') || cl.startsWith('-') || cl.startsWith('+') || cl === '') {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, items: [], eof: false };
              chunks.push(cur);
            } else throw new Exit2(`error: parse ${i + 2 + k}`);
          }
          const kind = cl.startsWith(' ') ? 'ctx' : cl.startsWith('-') ? 'old' : cl.startsWith('+') ? 'new' : 'ctx';
          cur.items.push({ kind, text: cl === '' ? '' : cl.slice(1), bs: false });
        } else {
          throw new Exit2(`error: parse ${i + 2 + k}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      const mv = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const { br, lines: fl0, final } = splitFile(before);
        let fl = [...fl0];
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null && ch.anchor !== '') {
            let found = -1;
            const tiers = strict ? [0] : [0, 1, 2];
            for (const t of tiers) {
              for (let idx = cursor; idx < fl.length; idx++) {
                if (lineEq(fl[idx]!, ch.anchor, t)) { found = idx; break; }
              }
              if (found >= 0) break;
            }
            if (found < 0) throw new Fail('no-match', p);
            cursor = found + 1;
          }
          const { o, n } = splitBody(ch.items);
          if (o.length === 0) {
            const ins = ch.eof ? fl.length : cursor;
            const rep = n.map((e) => e.text);
            fl = [...fl.slice(0, ins), ...rep, ...fl.slice(ins)];
            cursor = ins + rep.length;
          } else {
            let found: { tier: number; pos: number } | null = null;
            const tiers = strict ? [0] : [0, 1, 2];
            for (const t of tiers) {
              const occs = occurrencesAt(fl, o, t).filter((pos) => pos >= cursor && (!ch.eof || pos + o.length === fl.length));
              if (occs.length > 0) { found = { tier: t, pos: occs[0]! }; break; }
            }
            if (found === null) throw new Fail('no-match', p);
            const rep = buildNew(fl, found.pos, o, n, found.tier);
            fl = [...fl.slice(0, found.pos), ...rep, ...fl.slice(found.pos + o.length)];
            cursor = found.pos + rep.length;
          }
        }
        const out = joinFile(fl, br, final);
        if (mv !== null) {
          tree.now.set(p, null);
          tree.now.set(mv, out);
          tree.moves.push([p, mv]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
    i = j;
  }
  return edits;
}

/** Unified diffs (SPEC.md section 6). */
type UniHunk = { a: number; items: BodyItem[] };
type UniSection = {
  pairOld: string | null | undefined; pairNew: string | null | undefined;
  renameFrom: string | undefined; renameTo: string | undefined;
  diffOld: string | null; diffNew: string | null;
  isCreate: boolean; isDelete: boolean;
  hunks: UniHunk[];
};

/** A unified path: text after `--- `/`+++ `, up to the first tab, surrounding spaces removed; `/dev/null` is null; a leading a/ or b/ is removed. */
function uniPath(raw: string): string | null {
  let p = trimSpaces(raw.split('\t')[0]!);
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const parseDiffGit = (l: string): [string, string] | null => {
    if (!l.startsWith('diff --git a/')) return null;
    const rest = l.slice('diff --git '.length);
    const bIdx = rest.indexOf(' b/');
    if (bIdx < 0) return null;
    const x = rest.slice(2, bIdx);
    const y = rest.slice(bIdx + 3);
    if (x === '' || y === '') return null;
    return [x, y];
  };
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let hunk: UniHunk | null = null;
  const finishHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.items.length > 0) {
        const lastItem = hunk.items[hunk.items.length - 1]!;
        if (lastItem.kind === 'ctx' && lastItem.text === '') hunk.items.pop();
        else break;
      }
      cur.hunks.push(hunk);
      hunk = null;
    }
  };
  const finishSection = (): void => {
    finishHunk();
    if (cur !== null) { sections.push(cur); cur = null; }
    inHeader = false;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (hunk !== null) {
      // The body ends at a `--- ` line followed by a `+++ ` line (a new section starts there),
      // even though `--- ` begins with `-` like an old line.
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishHunk();
      } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
        if (l.startsWith('\\')) {
          const items = hunk.items;
          if (items.length > 0) {
            const lastItem = items[items.length - 1]!;
            if (lastItem.kind === 'ctx' || lastItem.kind === 'new') lastItem.bs = true;
          }
        } else if (l === '') {
          hunk.items.push({ kind: 'ctx', text: '', bs: false });
        } else if (l.startsWith(' ')) {
          hunk.items.push({ kind: 'ctx', text: l.slice(1), bs: false });
        } else if (l.startsWith('-')) {
          hunk.items.push({ kind: 'old', text: l.slice(1), bs: false });
        } else {
          hunk.items.push({ kind: 'new', text: l.slice(1), bs: false });
        }
        i++;
        continue;
      }
      finishHunk();
    }
    if (l.startsWith('diff --git')) {
      const dg = parseDiffGit(l);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      cur = { pairOld: undefined, pairNew: undefined, renameFrom: undefined, renameTo: undefined, diffOld: dg[0], diffNew: dg[1], isCreate: false, isDelete: false, hunks: [] };
      inHeader = true;
      i++;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.pairOld = uniPath(l.slice(4));
        cur.pairNew = uniPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        cur.pairNew = uniPath(l.slice(4));
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) { cur.renameFrom = l.slice('rename from '.length); i++; continue; }
      if (l.startsWith('rename to ')) { cur.renameTo = l.slice('rename to '.length); i++; continue; }
      if (l.startsWith('new file mode')) { cur.isCreate = true; i++; continue; }
      if (l.startsWith('deleted file mode')) { cur.isDelete = true; i++; continue; }
      const hm = HUNK_RE.exec(l);
      if (hm !== null) {
        hunk = { a: parseInt(hm[1]!, 10), items: [] };
        inHeader = false;
        i++;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      finishSection();
      cur = { pairOld: uniPath(l.slice(4)), pairNew: uniPath(lines[i + 1]!.slice(4)), renameFrom: undefined, renameTo: undefined, diffOld: null, diffNew: null, isCreate: false, isDelete: false, hunks: [] };
      inHeader = true;
      i += 2;
      continue;
    }
    const hm = HUNK_RE.exec(l);
    if (hm !== null) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: parseInt(hm[1]!, 10), items: [] };
      i++;
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  finishSection();

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.pairOld !== undefined ? s.pairOld : s.renameFrom !== undefined ? s.renameFrom : s.diffOld;
    const newP = s.pairNew !== undefined ? s.pairNew : s.renameTo !== undefined ? s.renameTo : s.diffNew;
    const isCreate = (oldP === null || s.isCreate) && newP !== null;
    const isDelete = !isCreate && (newP === null || s.isDelete) && oldP !== null;
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    if (isCreate) {
      const np = newP!;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plusLines: string[] = [];
        let lastPlusBs = false;
        for (const h of hunks) {
          for (const it of h.items) {
            if (it.kind === 'new') { plusLines.push(it.text); lastPlusBs = it.bs; }
          }
        }
        tree.now.set(np, plusLines.length === 0 ? '' : plusLines.join('\n') + (lastPlusBs ? '' : '\n'));
      });
    } else if (isDelete) {
      const op = oldP!;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      });
    } else if (oldP === null && newP === null) {
      edits.push((_tree) => { /* degenerate section: no paths, no change */ });
    } else {
      const op = oldP!;
      const np = newP!;
      const hunks = s.hunks;
      const move = isMove;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (move && !safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (move && tree.get(np) !== null) throw new Fail('exists', np);
        const { br, lines: fl0, final: final0 } = splitFile(before);
        let fl = [...fl0];
        let final = final0;
        let d = 0;
        for (const h of hunks) {
          const { o, n } = splitBody(h.items);
          const lastContent = [...h.items].reverse().find((it) => it.kind === 'ctx' || it.kind === 'new');
          const noBreak = lastContent !== undefined && lastContent.bs;
          if (o.length === 0) {
            const ins = Math.min(Math.max(h.a + d, 0), fl.length);
            const rep = n.map((e) => e.text);
            const atEnd = ins === fl.length;
            fl = [...fl.slice(0, ins), ...rep, ...fl.slice(ins)];
            if (atEnd) final = !noBreak;
            d += n.length;
          } else {
            const m = findMatch(fl, o, strict);
            if (m === null) throw new Fail('no-match', op);
            const target = h.a - 1 + d;
            let best = m.occs[0]!;
            for (const pos of m.occs) {
              if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
            }
            const rep = buildNew(fl, best, o, n, m.tier);
            const atEnd = best + o.length === fl.length;
            fl = [...fl.slice(0, best), ...rep, ...fl.slice(best + o.length)];
            if (atEnd) final = !noBreak;
            d += n.length - o.length;
          }
        }
        const out = joinFile(fl, br, final);
        if (move) {
          tree.now.set(op, null);
          tree.now.set(np, out);
          tree.moves.push([op, np]);
        } else {
          tree.now.set(op, out);
        }
      });
    }
  }
  return edits;
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
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
  const rowList: Array<{ key: string; line: string }> = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rowList.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      rOld.add(oldP);
      rNew.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowList.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowList.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowList.map((r) => r.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
