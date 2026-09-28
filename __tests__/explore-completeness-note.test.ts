/**
 * The completeness note at the end of a codegraph_explore response claims
 * "complete" only for sections that are.
 *
 * On the tiers with `includeCompletenessSignal` (>= 500 indexed files) every
 * response used to end with "Complete source for N files is included above —
 * do NOT re-read them", whatever the render had cut. That is how a 62-line
 * slice of vscode's 968-line `rpcProtocol.ts` was presented as complete: the
 * oversize-spine window elided most of the file and never set the trim flag
 * the small tiers' note keys off. The same line also said "Reserve Read for a
 * single specific line range", and explore output must never tell the agent to
 * Read (AGENTS.md).
 *
 * The fixture reproduces that shape: a flow whose spine runs through one long
 * method, which the render windows to its head plus the next-hop call site.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import {
  ToolHandler,
  elidedWantedSpans,
  exploreCompletenessNotes,
  shortestUniqueSuffixes,
  type ExploreWantedSpan,
} from '../src/mcp/tools';

const span = (
  name: string, start: number, end: number, importance = 1, spine = false, kind = 'method',
): ExploreWantedSpan => ({ name, kind, start, end, importance, spine });

/** The note this change replaced, for the size bound. */
const OLD_NOTE = '> **Complete source for 8 files is included above — do NOT re-read them.** If your question also needs files/symbols listed under "Not shown above" (or any area this call didn\'t cover), make ANOTHER codegraph_explore targeting those names — it returns the same source with line numbers and is cheaper and more complete than reading. Reserve Read for a single specific line range explore can\'t surface.';

/**
 * Anything that offers Read as a way forward. "treat it as already Read" is the
 * guarantee and "do not Read a file shown here" a prohibition — neither is an offer.
 */
const OFFERS_READ = /Reserve Read|use Read|Read for |fall back to Read/;
/** What follows the last source fence: the epilogue this change rewrote. */
const epilogueOf = (text: string): string => text.slice(text.lastIndexOf('```') + 3);

describe('elidedWantedSpans — judged on what was sent', () => {
  it('a span inside what was delivered is complete; one past its edge is not', () => {
    const elided = elidedWantedSpans(
      [span('inside', 10, 20), span('straddles', 25, 60), span('absent', 90, 95)],
      [{ start: 1, end: 40 }],
    );
    expect(elided.map((e) => e.name)).toEqual(['straddles', 'absent']);
  });

  it('counts a back-referenced span, and joins adjacent ranges', () => {
    // Lines 1–30 sent now, 31–50 held from an earlier call: one continuous copy.
    const elided = elidedWantedSpans([span('whole', 5, 45)], [{ start: 1, end: 30 }, { start: 31, end: 50 }]);
    expect(elided).toEqual([]);
  });

  it('orders the spine first, then importance, then source order', () => {
    const elided = elidedWantedSpans(
      [span('late', 80, 81, 9), span('peripheral', 5, 6, 1), span('flow', 50, 60, 3, true), span('early', 40, 41, 9)],
      [],
    );
    expect(elided.map((e) => e.name)).toEqual(['flow', 'early', 'late', 'peripheral']);
  });

  it('skips spans with no usable line range', () => {
    expect(elidedWantedSpans([span('zero', 0, 0), span('inverted', 9, 3)], [])).toEqual([]);
  });
});

describe('shortestUniqueSuffixes', () => {
  it('uses the basename unless another path ends with it', () => {
    const labels = shortestUniqueSuffixes([
      'src/vs/workbench/api/common/extHostExtensionService.ts',
      'src/vs/workbench/api/node/extHostExtensionService.ts',
      'src/vs/workbench/services/extensions/common/rpcProtocol.ts',
    ]);
    expect(labels.get('src/vs/workbench/api/common/extHostExtensionService.ts')).toBe('common/extHostExtensionService.ts');
    expect(labels.get('src/vs/workbench/api/node/extHostExtensionService.ts')).toBe('node/extHostExtensionService.ts');
    expect(labels.get('src/vs/workbench/services/extensions/common/rpcProtocol.ts')).toBe('rpcProtocol.ts');
  });

  it('falls back to the whole path when one path is a suffix of another', () => {
    const labels = shortestUniqueSuffixes(['a/b.ts', 'x/a/b.ts']);
    expect(labels.get('a/b.ts')).toBe('a/b.ts');
    expect(labels.get('x/a/b.ts')).toBe('x/a/b.ts');
  });
});

describe('exploreCompletenessNotes', () => {
  it('claims complete source only when nothing was trimmed, and never offers Read', () => {
    const notes = exploreCompletenessNotes(4, [], ['a.ts', 'b.ts']);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Complete source for 4 files');
    expect(notes[0]).not.toMatch(OFFERS_READ);
  });

  it('a trimmed response keeps the already-Read guarantee, names the files and the elided symbols', () => {
    const trimmed = [
      {
        filePath: 'src/vs/workbench/services/extensions/common/rpcProtocol.ts',
        elided: [
          span('_receiveOneMessage', 280, 357, 9, true),
          span('RPCProtocol', 200, 900, 9, false, 'class'), // a container is no follow-up target
          span('serializeRequest', 700, 720, 9),
          span('helperNobodyAskedFor', 10, 12, 1),
        ],
      },
    ];
    const notes = exploreCompletenessNotes(3, trimmed, ['src/vs/workbench/services/extensions/common/rpcProtocol.ts', 'src/a.ts']);
    for (const note of notes) {
      expect(note).not.toContain('Complete source');
      expect(note).toContain('Verbatim source for 3 files');
      expect(note).toContain('treat it as already Read');
      expect(note).toContain('codegraph_explore');
      expect(note).not.toMatch(OFFERS_READ);
    }
    expect(notes[0]).toContain('`rpcProtocol.ts`');
    expect(notes[0]).toContain('`_receiveOneMessage`, `serializeRequest`');
    expect(notes[0]).not.toContain('`RPCProtocol`');
    expect(notes[0]).not.toContain('helperNobodyAskedFor');
  });

  it('offers an elided method as Owner.member, so an overloaded name reaches the one that was cut', () => {
    const q = (s: ExploreWantedSpan, qualifiedName: string): ExploreWantedSpan => ({ ...s, qualifiedName });
    const trimmed = [{
      filePath: 'django/db/models/sql/compiler.py',
      elided: [
        q(span('as_sql', 776, 1003, 9, true), 'SQLCompiler::as_sql'),
        q(span('PLUGIN_ID', 5, 5, 9, false, 'method'), 'org.lamport.tla::HelpActivator::PLUGIN_ID'),
        q(span('inner', 40, 44, 9, false, 'function'), 'Outer::run::inner'), // a local function keeps its bare name
        q(span('odd', 50, 52, 9), 'src/a.py::odd'), // a path is no owner
      ],
    }];
    const [note] = exploreCompletenessNotes(1, trimmed, ['django/db/models/sql/compiler.py']);
    expect(note).toContain('(e.g. `SQLCompiler.as_sql`, `HelpActivator.PLUGIN_ID`, `inner`, `odd`)');
  });

  it('offers candidates from most to least specific, the last no longer than the note it replaced', () => {
    const trimmed = ['a', 'b', 'c', 'd', 'e'].map((n) => ({
      filePath: `packages/${n}/src/deeply/nested/${n}Service.ts`,
      elided: [span(`${n}Handler`, 10, 90, 9)],
    }));
    const notes = exploreCompletenessNotes(8, trimmed, trimmed.map((t) => t.filePath));
    expect(notes).toHaveLength(3);
    for (let i = 1; i < notes.length; i++) expect(notes[i]!.length).toBeLessThan(notes[i - 1]!.length);
    // Three files named, the rest counted.
    expect(notes[1]).toContain('`aService.ts`, `bService.ts`, `cService.ts` +2 more');
    // The last resort names nothing, so wherever the old note fit, it fits.
    expect(notes[2]).not.toContain('Service.ts');
    expect(notes[2]!.length).toBeLessThan(OLD_NOTE.length);
  });
});

describe('codegraph_explore — the note follows what the render cut', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  // Long enough that no tier ships the file whole, and past the 200-line
  // oversize-spine threshold, so the render windows `runPipeline` to its head
  // plus the `stepNext` call site.
  const FILLER = 360;
  const CALL_AT = 180;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-completeness-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"cg-completeness","version":"1.0.0"}\n');
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    const body: string[] = [
      "import { stepNext } from './step';",
      '',
      'export function runPipeline(input: number): number {',
      '  let acc = input;',
    ];
    for (let i = 0; i < FILLER; i++) {
      if (i === CALL_AT) body.push('  acc = stepNext(acc);');
      body.push(`  acc = acc + ${i}; // pipeline stage ${i}`);
    }
    body.push('  const PIPELINE_TAIL_MARKER = acc;', '  return PIPELINE_TAIL_MARKER;', '}', '');
    fs.writeFileSync(path.join(src, 'pipeline.ts'), body.join('\n'));
    // Three hops, because the flow only has a spine (and so a call site to
    // window to) for a chain of three or more.
    fs.writeFileSync(
      path.join(src, 'step.ts'),
      "import { finalizeStep } from './finalize';\n\nexport function stepNext(v: number): number {\n  return finalizeStep(v * 2);\n}\n",
    );
    fs.writeFileSync(path.join(src, 'finalize.ts'), 'export function finalizeStep(v: number): number {\n  return v + 1;\n}\n');
    // A second, small flow that renders whole: nothing to trim.
    fs.writeFileSync(
      path.join(src, 'format.ts'),
      "import { padValue } from './pad';\n\nexport function formatValue(v: number): string {\n  return padValue(String(v));\n}\n",
    );
    fs.writeFileSync(path.join(src, 'pad.ts'), "export function padValue(s: string): string {\n  return s.padStart(8, ' ');\n}\n");

    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  }, 120_000);

  afterAll(() => {
    cg?.destroy();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const explore = async (query: string, fileCount?: number): Promise<string> => {
    const spy = fileCount === undefined
      ? null
      : vi.spyOn(cg, 'getStats').mockReturnValue({ fileCount, nodeCount: 50 } as ReturnType<CodeGraph['getStats']>);
    try {
      const result = await handler.execute('codegraph_explore', { query });
      return result.content?.[0]?.text ?? '';
    } finally {
      spy?.mockRestore();
    }
  };

  it('large tier: a windowed spine method is reported trimmed, not complete', async () => {
    const text = await explore('runPipeline stepNext finalizeStep', 1000);
    // The fixture does what it is for: the method is windowed, so its tail is not in the response.
    expect(text).toContain('src/pipeline.ts');
    expect(text).toContain('stepNext(acc)');
    expect(text).not.toContain('PIPELINE_TAIL_MARKER');

    expect(text).not.toContain('Complete source for');
    expect(text).toContain('Verbatim source for');
    expect(text).toContain('treat it as already Read');
    expect(text).toMatch(/Trimmed for size: `pipeline\.ts`|Some sections were trimmed for size/);
    expect(epilogueOf(text)).not.toMatch(OFFERS_READ);
  });

  it('small tier: the same cut gets the trimmed note it used to miss', async () => {
    const text = await explore('runPipeline stepNext finalizeStep');
    expect(text).not.toContain('PIPELINE_TAIL_MARKER');
    expect(text).toContain('Some file sections were trimmed for size');
  });

  it('large tier: complete sections are still called complete, without the Read escape hatch', async () => {
    const text = await explore('formatValue padValue', 1000);
    expect(text).toContain('src/format.ts');
    expect(text).toContain('src/pad.ts');
    expect(text).toMatch(/Complete source for \d+ files is included above/);
    expect(text).not.toContain('Verbatim source for');
    expect(epilogueOf(text)).not.toMatch(OFFERS_READ);
  });

  it('small tier: complete sections get no trimmed note', async () => {
    const text = await explore('formatValue padValue');
    expect(text).not.toContain('trimmed for size');
  });
});
