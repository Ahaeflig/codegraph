import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

describe('Lua runtime parameters shadow module and name matches', () => {
  let dir: string;
  let cg: CodeGraph | undefined;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lua-param-')); });
  afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(dir, { recursive: true, force: true }); });
  it('does not bind a parameter call to a same-name imported module or function', async () => {
    fs.writeFileSync(path.join(dir, 'bridge.lua'), `
local Bridge = {}
function Bridge.call(op) return op end
return Bridge
`);
    fs.writeFileSync(path.join(dir, 'caller.lua'), `
local Bridge = require("bridge")
function shadowed(Bridge) return Bridge.call("task.run") end
function unrelated(other) return other.call("task.run") end
function callback() return 1 end
function invoke(callback) return callback() end
function known() return Bridge.call("task.run") end
`);
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const nodes = (name: string) => cg!.getNodesByName(name).find(n => n.kind === 'function' || n.kind === 'method')!;
    const callees = (name: string) => cg!.getCallees(nodes(name).id).map(x => x.node.name);
    expect(callees('shadowed')).not.toContain('call');
    expect(callees('unrelated')).not.toContain('call');
    expect(callees('invoke')).not.toContain('callback');
    expect(callees('known')).toContain('call');
  });
});
