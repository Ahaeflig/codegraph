/** AST-backed LuaJIT provenance. A name resembling `ffi` is never evidence. */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getParser } from '../extraction/grammars';
import { parseWithinBudget } from '../extraction/parse-budget';

export interface LuaArgument {
  text: string;
  kind: 'string' | 'identifier' | 'number' | 'unknown';
  value?: string;
  /** Zero-based parameter index when this expression forwards a parameter. */
  parameterIndex?: number;
}
export interface LuaCall {
  callee: string;
  resolvedCallee?: string;
  importedModule?: string;
  startIndex: number;
  endIndex: number;
  line: number;
  column: number;
  args: LuaArgument[];
  ffiSymbol?: string;
  /** The callee or its receiver currently derives from a lexical parameter. */
  parameterReceiver?: boolean;
  /** Its lexical root was declared as a parameter, even after reassignment. */
  parameterBinding?: boolean;
  /** That parameter replaced a proven namespace or function in an outer scope. */
  parameterShadowsNamespace?: boolean;
  functionStartIndex?: number;
  /** Proven lexical target, distinct from the function enclosing this call. */
  localFunctionStartIndex?: number;
}
export interface LuaFunction {
  name: string;
  startIndex: number;
  endIndex: number;
  line: number;
  column: number;
  endLine: number;
  parameters: string[];
}
export interface LuaAnalysis { calls: LuaCall[]; functions: LuaFunction[]; exportedFunctions: Record<string, number> }

type Value =
  | { kind: 'ffi' | 'library' | 'loader' | 'unknown' | 'nil' }
  | { kind: 'string' | 'number'; value: string }
  | { kind: 'parameter'; index: number; owner: number }
  | { kind: 'parameter_member'; index: number; owner: number }
  | { kind: 'function'; startIndex: number }
  | { kind: 'table'; id: number }
  | { kind: 'module'; module: string; member: string }
  | { kind: 'symbol'; name: string };
interface Cell { value: Value; parameterBinding?: boolean; parameterShadowsNamespace?: boolean; localBinding?: boolean }
type Scope = Map<string, Cell>;
type Env = Scope[];
const UNKNOWN: Value = { kind: 'unknown' };
const NIL: Value = { kind: 'nil' };

function field(n: SyntaxNode, name: string): SyntaxNode | null { return n.childForFieldName(name); }
function children(n: SyntaxNode): SyntaxNode[] { return n.namedChildren.filter(c => c.type !== 'comment'); }
function lookup(env: Env, name: string): Cell | undefined {
  for (let i = env.length - 1; i >= 0; i--) {
    const cell = env[i]!.get(name);
    if (cell) return cell;
  }
  return undefined;
}
function captured(env: Env, origins: WeakMap<Cell, Cell>): Env {
  return env.map(scope => new Map([...scope].map(([name, cell]) => [name, origins.get(cell) ?? cell])));
}
function merge(values: Value[]): Value {
  const present = values.filter(v => v.kind !== 'nil');
  if (!present.length) return NIL;
  const first = present[0]!;
  return present.every(v => JSON.stringify(v) === JSON.stringify(first)) ? first : UNKNOWN;
}
function literal(n: SyntaxNode): string | undefined {
  if (n.type !== 'string') return undefined;
  // Decode only literals, never source text containing comments or expressions.
  const raw = n.text;
  const long = /^\[(=*)\[([\s\S]*)\]\1\]$/.exec(raw);
  if (long) return long[2]!.replace(/^\r?\n/, '');
  if ((raw[0] !== '"' && raw[0] !== "'") || raw.at(-1) !== raw[0]) return undefined;
  let result = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i]!;
    if (c !== '\\') { result += c; continue; }
    const next = raw[++i];
    if (next === undefined) return undefined;
    const escapes: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'" };
    if (next in escapes) result += escapes[next];
    else if (next === '\n') result += '\n';
    else return undefined; // Unknown escape: do not guess the exported symbol.
  }
  return result;
}

/** The caller preloads the Lua grammar; no AST objects escape this function. */
export function analyzeLua(source: string): LuaAnalysis {
  const result: LuaAnalysis = { calls: [], functions: [], exportedFunctions: {} };
  const parser = getParser('lua');
  if (!parser) return result;
  const tree = parseWithinBudget(parser, source);
  if (!tree) return result;
  const tables = new Map<number, Map<string, Value>>();
  const invalidTables = new Set<number>();
  const invalidMembers = new Map<number, Set<string>>();
  const invalidModules = new Set<string>();
  const namespaceReturns = new Map<number, Value>();
  const invalidCaptured = new Set<Cell>();
  const invalidLibraries = new WeakSet<Value>();
  const moduleReturns: Array<{ value: Value; unconditional: boolean }> = [];
  let conditionalDepth = 0;
  const origins = new WeakMap<Cell, Cell>();
  let writes = new Map<Cell, Value[]>();
  let infer = false;
  const isolate = (env: Env): Env => env.map(scope => new Map([...scope].map(([key, cell]) => {
    const copy: Cell = { value: cell.value,
      ...(cell.parameterBinding ? { parameterBinding: true } : {}),
      ...(cell.parameterShadowsNamespace ? { parameterShadowsNamespace: true } : {}),
      ...(cell.localBinding ? { localBinding: true } : {}) };
    origins.set(copy, origins.get(cell) ?? cell);
    return [key, copy];
  })));
  const pending: Array<{ node: SyntaxNode; env: Env; name: string; namespaceGetter: boolean }> = [];

  const argsOf = (n: SyntaxNode): SyntaxNode[] => {
    const args = field(n, 'arguments');
    return args ? children(args) : [];
  };
  const provenValue = (value: Value): Value => {
    if ((value.kind === 'ffi' && invalidModules.has('ffi')) ||
        (value.kind === 'module' && invalidModules.has(value.module)) ||
        (value.kind === 'library' && invalidLibraries.has(value))) return UNKNOWN;
    return value;
  };
  const valueOf = (n: SyntaxNode | undefined | null, env: Env): Value => {
    if (!n) return NIL;
    if (n.type === 'identifier') {
      const cell = lookup(env, n.text);
      if (cell && invalidCaptured.has(origins.get(cell) ?? cell)) return UNKNOWN;
      return provenValue(cell?.value ?? UNKNOWN);
    }
    if (n.type === 'function_definition') return { kind: 'function', startIndex: n.startIndex };
    if (n.type === 'table_constructor') {
      if (!tables.has(n.startIndex)) {
        const members = new Map<string, Value>();
        tables.set(n.startIndex, members);
        for (const entry of children(n)) {
          const keyNode = field(entry, 'name');
          const bracketed = entry.children.some(c => c.type === '[');
          const key = keyNode?.type === 'identifier' && !bracketed ? keyNode.text : keyNode ? literal(keyNode) : undefined;
          if (!key) { invalidTables.add(n.startIndex); continue; }
          members.set(key, valueOf(field(entry, 'value'), env));
        }
      }
      return { kind: 'table', id: n.startIndex };
    }
    if (n.type === 'nil') return NIL;
    if (n.type === 'string') { const value = literal(n); return value === undefined ? UNKNOWN : { kind: 'string', value }; }
    if (n.type === 'number') return { kind: 'number', value: n.text };
    if (n.type === 'parenthesized_expression') return valueOf(children(n)[0], env);
    if (n.type === 'dot_index_expression' || n.type === 'method_index_expression' || n.type === 'bracket_index_expression') {
      const table = field(n, 'table') ?? children(n)[0];
      const memberNode = field(n, 'field') ?? field(n, 'method') ?? children(n)[1];
      const member = memberNode?.type === 'identifier' && n.type !== 'bracket_index_expression' ? memberNode.text : memberNode ? literal(memberNode) : undefined;
      const receiver = provenValue(valueOf(table, env));
      if (receiver.kind === 'parameter' || receiver.kind === 'parameter_member') {
        return { kind: 'parameter_member', index: receiver.index, owner: receiver.owner };
      }
      if (!member) return UNKNOWN;
      if (receiver.kind === 'ffi' && member === 'C') return { kind: 'library' };
      if (receiver.kind === 'ffi' && member === 'load') return { kind: 'loader' };
      if (receiver.kind === 'library') return { kind: 'symbol', name: member };
      if (receiver.kind === 'table') return invalidTables.has(receiver.id) || invalidMembers.get(receiver.id)?.has(member) ? UNKNOWN : provenValue(tables.get(receiver.id)?.get(member) ?? UNKNOWN);
      if (receiver.kind === 'module') return { ...receiver, member: receiver.member ? `${receiver.member}.${member}` : member };
      return UNKNOWN;
    }
    if (n.type === 'function_call') {
      const name = field(n, 'name');
      const args = argsOf(n);
      if (name?.type === 'identifier' && name.text === 'require' && !lookup(env, 'require')) {
        const mod = args[0] ? literal(args[0]) : undefined;
        if (mod && invalidModules.has(mod)) return UNKNOWN;
        if (mod === 'ffi') return { kind: 'ffi' };
        if (mod) return { kind: 'module', module: mod, member: '' };
      }
      const callee = valueOf(name, env);
      if (callee.kind === 'loader') return { kind: 'library' };
      if (callee.kind === 'function') {
        return provenValue(namespaceReturns.get(callee.startIndex) ?? UNKNOWN);
      }
    }
    return UNKNOWN;
  };
  const argument = (n: SyntaxNode, env: Env, owner?: number): LuaArgument => {
    const value = valueOf(n, env);
    if (value.kind === 'string' || value.kind === 'number') return { text: n.text, kind: value.kind, value: value.value };
    if (n.type === 'identifier') return { text: n.text, kind: 'identifier', value: n.text, ...(value.kind === 'parameter' && value.owner === owner ? { parameterIndex: value.index } : {}) };
    return { text: n.text, kind: 'unknown' };
  };
  const set = (env: Env, name: string, value: Value, local: boolean, parameter = false, shadowsNamespace = false): void => {
    if (local) env.at(-1)!.set(name, { value, localBinding: true,
      ...(parameter ? { parameterBinding: true } : {}),
      ...(shadowsNamespace ? { parameterShadowsNamespace: true } : {}) });
    else {
      const cell = lookup(env, name);
      if (cell) {
        const origin = origins.get(cell);
        if (infer && origin) {
          const entries = writes.get(origin) ?? [];
          entries.push(value);
          writes.set(origin, entries);
        }
        cell.value = value;
      }
      else env[0]!.set(name, { value });
    }
  };
  const receiverCell = (callee: SyntaxNode, env: Env): Cell | undefined => {
    let root: SyntaxNode | undefined = callee;
    while (root && root.type !== 'identifier') {
      if (root.type === 'parenthesized_expression') root = children(root)[0];
      else if (root.type === 'dot_index_expression' || root.type === 'method_index_expression' || root.type === 'bracket_index_expression') {
        root = field(root, 'table') ?? children(root)[0];
      } else return undefined;
    }
    return root === undefined ? undefined : lookup(env, root.text);
  };
  const invalidateReceiver = (target: SyntaxNode, env: Env): void => {
    // Mutating a namespace invalidates its proven aliases as well.
    let receiver = field(target, 'table');
    const receivers = [valueOf(receiver, env)];
    while (receiver && receiver.type !== 'identifier') receiver = field(receiver, 'table');
    if (receiver) receivers.push(valueOf(receiver, env));
    for (const previous of new Set(receivers)) {
      if (previous.kind === 'ffi' || previous.kind === 'library' || previous.kind === 'module') {
        if (previous.kind === 'ffi') invalidModules.add('ffi');
        if (previous.kind === 'module') invalidModules.add(previous.module);
        if (previous.kind === 'library') invalidLibraries.add(previous);
        env.forEach(scope => scope.forEach(cell => {
          const value = cell.value;
          const same = value === previous ||
            (previous.kind === 'ffi' && value.kind === 'ffi') ||
            (previous.kind === 'module' && value.kind === 'module' && value.module === previous.module);
          if (!same) return;
          const origin = origins.get(cell);
          if (origin) invalidCaptured.add(origin);
          if (infer && origin) writes.set(origin, [...(writes.get(origin) ?? []), UNKNOWN]);
          cell.value = UNKNOWN;
        }));
      }
    }
  };
  const assignMember = (target: SyntaxNode, value: Value, env: Env, owner?: number): void => {
    const receiver = valueOf(field(target, 'table'), env);
    if (receiver.kind !== 'table') { invalidateReceiver(target, env); return; }
    const memberNode = field(target, 'field') ?? field(target, 'method') ?? children(target)[1];
    const member = memberNode?.type === 'identifier' && target.type !== 'bracket_index_expression' ? memberNode.text : memberNode ? literal(memberNode) : undefined;
    // Unknown keys can overwrite any member; known keys affect only that slot.
    if (!member) invalidTables.add(receiver.id);
    else if (owner !== undefined || conditionalDepth) {
      const members = invalidMembers.get(receiver.id) ?? new Set<string>();
      members.add(member);
      invalidMembers.set(receiver.id, members);
    }
    else tables.get(receiver.id)?.set(member, value);
  };
  const visit = (n: SyntaxNode, env: Env, owner?: number, assignedName?: string): void => {
    if (n.type === 'comment' || n.type === 'string' || n.type === 'ERROR') return;
    if (n.type === 'function_declaration' || n.type === 'function_definition') {
      const name = field(n, 'name');
      const fnName = name?.text ?? assignedName ?? '';
      const assignment = n.parent?.type === 'expression_list' ? n.parent.parent : null;
      const namespaceGetter = name?.type === 'identifier'
        ? n.children.some(c => c.type === 'local') || lookup(env, name.text)?.localBinding === true
        : name === null && !!assignedName && /^[A-Za-z_]\w*$/.test(assignedName) &&
          (assignment?.type === 'assignment_statement' && assignment.parent?.type === 'variable_declaration' || lookup(env, assignedName)?.localBinding === true);
      if (name?.type === 'identifier') set(env, name.text, { kind: 'function', startIndex: n.startIndex }, n.children.some(c => c.type === 'local'));
      else if (name) assignMember(name, { kind: 'function', startIndex: n.startIndex }, env, owner);
      pending.push({ node: n, env: captured(env, origins), name: fnName, namespaceGetter });
      return;
    }
    if (n.type === 'table_constructor') {
      for (const entry of children(n)) {
        const keyNode = field(entry, 'name');
        const bracketed = entry.children.some(c => c.type === '[');
        const key = keyNode?.type === 'identifier' && !bracketed ? keyNode.text : keyNode ? literal(keyNode) : undefined;
        const value = field(entry, 'value');
        if (bracketed && keyNode) visit(keyNode, env, owner);
        if (value) visit(value, env, owner, key ? assignedName ? `${assignedName}.${key}` : key : undefined);
      }
      return;
    }
    if (n.type === 'variable_declaration' || n.type === 'assignment_statement') {
      const assign = n.type === 'variable_declaration' ? children(n).find(c => c.type === 'assignment_statement') ?? n : n;
      const vars = children(assign).find(c => c.type === 'variable_list');
      const exprs = children(assign).find(c => c.type === 'expression_list');
      const targets = vars ? children(vars) : children(assign).filter(c => c.type === 'identifier');
      const expressions = exprs ? children(exprs) : [];
      const values = expressions.map(e => valueOf(e, env));
      // Lua pcall returns its success flag, followed by ffi.load's library.
      const first = expressions[0];
      if (first?.type === 'function_call' && expressions.length === 1) {
        const callee = field(first, 'name');
        if (callee?.type === 'identifier' && callee.text === 'pcall' && !lookup(env, 'pcall') && valueOf(argsOf(first)[0], env).kind === 'loader') {
          values[0] = UNKNOWN;
          values[1] = { kind: 'library' };
        }
      }
      expressions.forEach((e, i) => visit(e, env, owner, targets[i]?.text));
      targets.forEach((target, i) => {
        if (target.type === 'identifier') set(env, target.text, values[i] ?? NIL, n.type === 'variable_declaration');
        else {
          assignMember(target, values[i] ?? NIL, env, owner);
        }
      });
      return;
    }
    if (n.type === 'return_statement' && owner === undefined) {
      const list = children(n).find(c => c.type === 'expression_list');
      const expressions = list ? children(list) : [];
      moduleReturns.push({ value: expressions.length === 1 ? valueOf(expressions[0], env) : UNKNOWN, unconditional: n.parent?.type === 'chunk' });
    }
    if (n.type === 'function_call') {
      const name = field(n, 'name');
      if (name) {
        const value = valueOf(name, env);
        const cell = receiverCell(name, env);
        argsOf(n).forEach(arg => { const passed = valueOf(arg, env); if (passed.kind === 'table') invalidTables.add(passed.id); });
        if (!infer) result.calls.push({ callee: name.text, startIndex: n.startIndex, endIndex: n.endIndex,
          line: n.startPosition.row + 1, column: n.startPosition.column,
          args: [...(name.type === 'method_index_expression' ? [{ text: field(name, 'table')?.text ?? '', kind: 'unknown' as const }] : []), ...argsOf(n).map(a => argument(a, env, owner))],
          ...(value.kind === 'symbol' ? { ffiSymbol: value.name } : {}),
          ...(value.kind === 'function' ? { localFunctionStartIndex: value.startIndex } : {}),
          ...(value.kind === 'module' ? { resolvedCallee: value.member, importedModule: value.module } : {}),
          ...(value.kind === 'parameter' || value.kind === 'parameter_member' ? { parameterReceiver: true } : {}),
          ...(cell?.parameterBinding ? { parameterBinding: true } : {}),
          ...(cell?.parameterShadowsNamespace ? { parameterShadowsNamespace: true } : {}),
          ...(owner === undefined ? {} : { functionStartIndex: owner }) });
      }
    }
    if (n.type === 'if_statement') {
      const condition = field(n, 'condition');
      if (condition) visit(condition, env, owner);
      const arms = children(n).filter(c => c.type === 'block' || c.type === 'elseif_statement' || c.type === 'else_statement');
      conditionalDepth++;
      const states: Env[] = arms.map(arm => { const branch = isolate(env); visit(arm, branch, owner); return branch; });
      conditionalDepth--;
      if (!arms.some(arm => arm.type === 'else_statement')) states.push(isolate(env));
      env.forEach((scope, index) => scope.forEach((cell, key) => {
        cell.value = merge(states.map(state => state[index]!.get(key)?.value ?? NIL));
      }));
      return;
    }
    if (n.type === 'repeat_statement') {
      const loop = [...env, new Map<string, Cell>()];
      conditionalDepth++;
      for (const child of children(n)) {
        if (child.type === 'block') children(child).forEach(statement => visit(statement, loop, owner));
        else visit(child, loop, owner);
      }
      conditionalDepth--;
      return;
    }
    if (n.type === 'while_statement') {
      conditionalDepth++;
      children(n).forEach(child => visit(child, env, owner));
      conditionalDepth--;
      return;
    }
    if (n.type === 'for_statement') {
      const clause = field(n, 'clause');
      const loop = [...env, new Map<string, Cell>()];
      if (clause) {
        const vars = children(clause).find(c => c.type === 'variable_list');
        const names = vars ? children(vars) : [field(clause, 'name')].filter((v): v is SyntaxNode => v !== null);
        children(clause).filter(c => c !== vars && !names.some(v => v.startIndex === c.startIndex)).forEach(c => visit(c, env, owner));
        names.forEach(name => set(loop, name.text, UNKNOWN, true));
      }
      const body = field(n, 'body');
      conditionalDepth++;
      if (body) visit(body, loop, owner);
      conditionalDepth--;
      return;
    }
    if (n.type === 'block' || n.type === 'do_statement') {
      const nested = [...env, new Map<string, Cell>()];
      children(n).forEach(c => visit(c, nested, owner));
      return;
    }
    children(n).forEach(c => visit(c, env, owner));
  };
  try {
    visit(tree.rootNode, [new Map()]);
    const rootFunctions = [...pending];
    const initial = new Map<Cell, Value>();
    rootFunctions.forEach(fn => fn.env.forEach(scope => scope.forEach(cell => initial.set(cell, cell.value))));
    const passive = (node: SyntaxNode): boolean => node.type !== 'function_call' && node.type !== 'ERROR' && children(node).every(passive);
    const namespaceExpression = (node: SyntaxNode, env: Env): boolean => {
      if (node.type === 'identifier') return true;
      if (node.type === 'parenthesized_expression') {
        const expression = children(node)[0];
        return expression !== undefined && namespaceExpression(expression, env);
      }
      if (node.type === 'dot_index_expression' || node.type === 'bracket_index_expression') {
        const receiver = field(node, 'table');
        const member = field(node, 'field') ?? children(node)[1];
        return receiver !== null && namespaceExpression(receiver, env) &&
          (node.type !== 'bracket_index_expression' || member !== undefined && literal(member) !== undefined);
      }
      if (node.type !== 'function_call') return false;
      const name = field(node, 'name');
      const args = argsOf(node);
      if (name?.type === 'identifier' && name.text === 'require' && !lookup(env, 'require')) {
        return args.length === 1 && literal(args[0]!) !== undefined;
      }
      const callee = valueOf(name, env);
      return callee.kind === 'function' && namespaceReturns.has(callee.startIndex) && args.every(passive);
    };
    let returnsChanged = false;
    const analyzeFunctions = (): void => {
      for (let i = 0; i < pending.length; i++) {
        const { node, env, name, namespaceGetter } = pending[i]!;
        const local = isolate(env);
        local.push(new Map());
        const params = field(node, 'parameters');
        const parameters = params ? children(params).filter(p => p.type === 'identifier').map(p => p.text) : [];
        if (field(node, 'name')?.type === 'method_index_expression') parameters.unshift('self');
        const shadowsNamespaces = parameters.map(p => {
          const cell = lookup(local, p);
          const value = cell && !invalidCaptured.has(origins.get(cell) ?? cell) ? provenValue(cell.value) : UNKNOWN;
          return value.kind === 'ffi' || value.kind === 'library' || value.kind === 'module' || value.kind === 'function';
        });
        parameters.forEach((p, index) => set(local, p, { kind: 'parameter', index, owner: node.startIndex }, true, true, shadowsNamespaces[index]));
        if (!infer) result.functions.push({ name, startIndex: node.startIndex, endIndex: node.endIndex, line: node.startPosition.row + 1, column: node.startPosition.column, endLine: node.endPosition.row + 1, parameters });
        const body = field(node, 'body') ?? children(node).find(c => c.type === 'block');
        if (namespaceGetter) {
          const statements = body ? children(body) : [];
          const statement = statements.length === 1 && statements[0]!.type === 'return_statement' ? statements[0] : undefined;
          const list = statement && children(statement).find(child => child.type === 'expression_list');
          const expressions = list ? children(list) : [];
          const value = expressions.length === 1 && namespaceExpression(expressions[0]!, local) ? valueOf(expressions[0], local) : UNKNOWN;
          const proven = value.kind === 'module' || value.kind === 'ffi' || value.kind === 'library' ? value : UNKNOWN;
          if (JSON.stringify(namespaceReturns.get(node.startIndex) ?? UNKNOWN) !== JSON.stringify(proven)) returnsChanged = true;
          namespaceReturns.set(node.startIndex, proven);
        }
        if (body) visit(body, local, node.startIndex);
      }
    };
    // Captured assignments must agree. Namespace getters have one return, so
    // their summaries participate in the same bounded fixed point.
    infer = true;
    for (let round = 0; round <= pending.length; round++) {
      pending.splice(0, pending.length, ...rootFunctions);
      writes = new Map();
      returnsChanged = false;
      analyzeFunctions();
      let changed = returnsChanged;
      initial.forEach((base, cell) => {
        const value = invalidCaptured.has(cell) ? UNKNOWN : merge([base, ...(writes.get(cell) ?? [])]);
        if (JSON.stringify(cell.value) !== JSON.stringify(value)) { cell.value = value; changed = true; }
      });
      if (!changed) break;
    }
    infer = false;
    pending.splice(0, pending.length, ...rootFunctions);
    analyzeFunctions();
    if (moduleReturns.length === 1 && moduleReturns[0]!.unconditional) {
      const exports: Record<string, number> = {};
      const collect = (value: Value, prefix: string, seen: Set<number>): void => {
        if (value.kind === 'function') exports[prefix] = value.startIndex;
        else if (value.kind === 'table' && !seen.has(value.id) && !invalidTables.has(value.id)) {
          const next = new Set(seen).add(value.id);
          tables.get(value.id)?.forEach((member, key) => {
            if (!invalidMembers.get(value.id)?.has(key)) collect(member, prefix ? `${prefix}.${key}` : key, next);
          });
        }
      };
      collect(moduleReturns[0]!.value, '', new Set());
      result.exportedFunctions = exports;
    }
    result.calls.sort((a, b) => a.startIndex - b.startIndex);
    result.functions.sort((a, b) => a.startIndex - b.startIndex);
    return result;
  } finally { tree.delete(); }
}
