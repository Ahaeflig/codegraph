/** Conservative Cargo/module identity for source-derived FFI dispatch.
 * A unique short type name is never evidence of a cross-crate binding.
 * Supported external bindings require a local path dependency (including a
 * workspace-inherited path dependency) and declared, indexed Rust modules.
 */
import * as path from 'node:path';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getParser } from '../extraction/grammars';
import { parseWithinBudget } from '../extraction/parse-budget';
import type { ResolutionContext } from './types';
import type { RustOwnerResolver } from './rust-ffi-analysis';

interface Crate { dir: string; manifest: string; root: string; name?: string }
interface Module { file: string; inline: string[] }
interface Decl { name: string; inline: boolean; customPath: boolean }
const normal = (s: string): string => path.posix.normalize(s).replace(/^\.\//, '');
const safe = (s: string): boolean => !path.posix.isAbsolute(s) && s !== '..' && !s.startsWith('../');

// Deliberately small TOML subset. Unknown/escaped/multiline values do not
// become guessed paths; duplicate keys are rejected.
function section(source: string, name: string): Map<string, string> {
  const out = new Map<string, string>();
  let active = false;
  for (const line of source.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) { active = header[1] === name; continue; }
    if (!active) continue;
    const entry = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (entry) out.set(entry[1]!, out.has(entry[1]!) ? '' : entry[2]!);
  }
  return out;
}
function stringValue(raw: string | undefined): string | undefined {
  return raw && /^(["'])([^"'\\\r\n]*)\1\s*(?:#.*)?$/.exec(raw)?.[2] || undefined;
}
function inlineString(raw: string, key: string): string | undefined {
  // No nested tables; quoted strings cannot inject fields into this parser.
  const match = /^\{([^{}]*)\}\s*(?:#.*)?$/.exec(raw);
  if (!match) return undefined;
  const fields = match[1]!.match(/(?:[A-Za-z0-9_-]+)\s*=\s*(?:"[^"\\]*"|'[^'\\]*'|true|false)\s*(?:,|$)/g);
  if (!fields || fields.join('').replace(/\s/g, '') !== match[1]!.replace(/\s/g, '')) return undefined;
  const values = fields.filter(f => new RegExp(`^\\s*${key}\\s*=`).test(f));
  return values.length === 1 ? stringValue(values[0]!.replace(/^\s*\w+\s*=\s*/, '').replace(/,\s*$/, '')) : undefined;
}

export function createRustBridgeIdentity(ctx: ResolutionContext): RustOwnerResolver {
  const crates = new Map<string, Crate | null>();
  const modules = new Map<string, Map<string, Decl[]> | null>();
  const readCrate = (dir: string): Crate | null => {
    const known = crates.get(dir);
    if (known !== undefined) return known;
    const manifest = ctx.readFile(normal(path.posix.join(dir, 'Cargo.toml')));
    if (manifest === null) { crates.set(dir, null); return null; }
    const lib = section(manifest, 'lib');
    const configuredRoot = stringValue(lib.get('path'));
    if (lib.has('path') && configuredRoot === undefined) { crates.set(dir, null); return null; }
    const relativeRoot = configuredRoot ?? 'src/lib.rs';
    const root = normal(path.posix.join(dir, relativeRoot));
    if (!safe(root) || !ctx.fileExists(root)) { crates.set(dir, null); return null; }
    const name = (stringValue(lib.get('name')) ?? stringValue(section(manifest, 'package').get('name')))?.replace(/-/g, '_');
    const value = { dir, manifest, root, name };
    crates.set(dir, value);
    return value;
  };
  const nearest = (file: string): Crate | null => {
    let dir = path.posix.dirname(file);
    while (safe(dir)) {
      const crate = readCrate(dir);
      if (crate) return crate;
      if (dir === '.') break;
      dir = path.posix.dirname(dir);
    }
    return null;
  };
  const declarations = (file: string): Map<string, Decl[]> | null => {
    if (modules.has(file)) return modules.get(file)!;
    const source = ctx.readFile(file);
    const parser = getParser('rust');
    const tree = source !== null && parser ? parseWithinBudget(parser, source) : null;
    if (!tree) { modules.set(file, null); return null; }
    const out = new Map<string, Decl[]>();
    const scan = (node: SyntaxNode, scope: string[]): void => {
      for (const child of node.namedChildren) {
        if (child.type !== 'mod_item') continue;
        const name = child.childForFieldName('name')?.text;
        if (!name) continue;
        const body = child.childForFieldName('body');
        let sibling = child.previousNamedSibling;
        let customPath = false;
        while (sibling && (sibling.type === 'attribute_item' || sibling.type.endsWith('comment'))) {
          if (sibling.type === 'attribute_item' && /\bpath\s*=/.test(sibling.text)) customPath = true;
          sibling = sibling.previousNamedSibling;
        }
        const key = scope.join('::');
        const list = out.get(key) ?? [];
        list.push({ name, inline: !!body, customPath }); out.set(key, list);
        if (body) scan(body, [...scope, name]);
      }
    };
    try { scan(tree.rootNode, []); } finally { tree.delete(); }
    modules.set(file, out); return out;
  };
  const descend = (start: Module, parts: string[]): Module | null => {
    let current = start;
    for (const name of parts) {
      if (!/^\w+$/.test(name)) return null;
      const matches = declarations(current.file)?.get(current.inline.join('::'))?.filter(d => d.name === name) ?? [];
      if (matches.length !== 1 || matches[0]!.customPath) return null;
      if (matches[0]!.inline) { current = { ...current, inline: [...current.inline, name] }; continue; }
      const base = path.posix.basename(current.file);
      const dir = ['lib.rs', 'main.rs', 'mod.rs'].includes(base) ? path.posix.dirname(current.file) : current.file.replace(/\.rs$/, '');
      const stem = normal(path.posix.join(dir, ...current.inline, name));
      const choices = [`${stem}.rs`, `${stem}/mod.rs`].filter(f => ctx.fileExists(f));
      if (choices.length !== 1) return null;
      current = { file: choices[0]!, inline: [] };
    }
    return current;
  };
  const reachableFiles = new Map<string, Set<string>>();
  const isDeclaredFile = (root: string, file: string): boolean => {
    let files = reachableFiles.get(root);
    if (!files) {
      files = new Set();
      const seen = new Set<string>();
      const queue: Module[] = [{ file: root, inline: [] }];
      for (let i = 0; i < queue.length; i++) {
        const current = queue[i]!;
        const key = `${current.file}#${current.inline.join('::')}`;
        if (seen.has(key)) continue;
        seen.add(key); files.add(current.file);
        for (const decl of declarations(current.file)?.get(current.inline.join('::')) ?? []) {
          const next = descend(current, [decl.name]);
          if (next) queue.push(next);
        }
      }
      reachableFiles.set(root, files);
    }
    return files.has(file);
  };
  const dependency = (crate: Crate, name: string): Crate | null => {
    const entries = [...section(crate.manifest, 'dependencies')].filter(([key]) => key.replace(/-/g, '_') === name);
    let dependencyPath: string | undefined;
    let baseDir = crate.dir;
    if (entries.length === 1) {
      const [key, raw] = entries[0]!;
      dependencyPath = inlineString(raw, 'path');
      if (!dependencyPath && /^\{\s*workspace\s*=\s*true\s*\}\s*(?:#.*)?$/.test(raw)) {
        let dir = crate.dir;
        while (safe(dir)) {
          const manifest = ctx.readFile(normal(path.posix.join(dir, 'Cargo.toml')));
          const inherited = manifest && section(manifest, 'workspace.dependencies').get(key);
          if (inherited) { dependencyPath = inlineString(inherited, 'path'); baseDir = dir; break; }
          if (dir === '.') break;
          dir = path.posix.dirname(dir);
        }
      }
    } else if (entries.length === 0) {
      dependencyPath = stringValue(section(crate.manifest, `dependencies.${name}`).get('path'));
    }
    if (!dependencyPath) return null;
    const dir = normal(path.posix.join(baseDir, dependencyPath));
    return safe(dir) ? readCrate(dir) : null;
  };
  return (ownerPath, caller, candidates) => {
    const parts = ownerPath.split('::').filter(Boolean);
    const leaf = parts.pop();
    if (!leaf || parts.length === 0) return undefined;
    const crate = nearest(caller.filePath);
    if (!crate) return undefined;
    let targetCrate = crate;
    let start: Module = { file: caller.filePath, inline: caller.modulePath.split('::').filter(Boolean) };
    let relativeTarget: Module | null = null;
    const first = parts[0];
    if (first === 'crate' || first === crate.name) { parts.shift(); start = { file: crate.root, inline: [] }; }
    else if (first === 'self') parts.shift();
    else if (first === 'super') return undefined; // requires parent-module ancestry, deliberately not guessed
    else {
      relativeTarget = ownerPath.startsWith('::') ? null : descend(start, parts);
      if (!relativeTarget) {
        const dep = dependency(crate, parts.shift()!);
        if (!dep) return undefined;
        targetCrate = dep;
        start = { file: dep.root, inline: [] };
      }
    }
    const target = relativeTarget ?? descend(start, parts);
    if (!target) return undefined;
    const macros = candidates.filter(fn => fn.isMacro && fn.macroExport && fn.name === leaf &&
      target.file === targetCrate.root && target.inline.length === 0 &&
      nearest(fn.filePath)?.root === targetCrate.root && isDeclaredFile(targetCrate.root, fn.filePath));
    if (macros.length) return macros.length === 1 ? macros[0] : undefined;
    const matches = candidates.filter(fn => !fn.isMacro && fn.filePath === target.file &&
      fn.modulePath.split('::').filter(Boolean).join('::') === target.inline.join('::') &&
      (fn.owner === leaf || (!fn.owner && fn.name === leaf)));
    return matches.length === 1 ? matches[0] : undefined;
  };
}
