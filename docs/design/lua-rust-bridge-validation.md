# LuaJIT → Rust bridge validation

Validated on Linux x64 on 2026-10-04 against main
[`6560052`](https://github.com/colbymchenry/codegraph/commit/6560052a6f856855d3f71eee838fd66ccfa4285d)
(v1.6.2). Implementation checks pass; the required agent A/B remains pending.

## Repositories and deterministic results

Fresh baseline and patched indexes used Node 24.19.0 with
`CODEGRAPH_KERNEL=0`, the same corpus revisions, and the same exclusions.
Bridge counts include operation calls, ordinary FFI calls, and physical
transport references; they are not counts of complete runtime flows.

| Corpus | Indexed files | Nodes, baseline → patched | Bridge edges, baseline → patched | Fresh index seconds, baseline → patched |
|---|---:|---:|---:|---:|
| [RunRustFromLua](https://github.com/Jim-Holmstroem/RunRustFromLua/tree/93bd640f75ce53e3081d666e8e22daef17b30d72), small positive | 2 | 34 → 34 | 0 → 6 | 0.287 → 0.310 |
| Private gameplay monorepo, medium positive | 1,955 | 60,227 → 60,227 | 0 → 80 | 32.285 → 51.834 |
| [Ruff](https://github.com/astral-sh/ruff/tree/127e77ef8bee49f21c0e7c2ff1e38ccf27fb522a), large Rust control | 5,082 | 83,542 → 83,542 | 0 → 0 | 34.471 → 28.544 |

These timings are single-run observations with cache/load variance. The
positive monorepo pays for another Lua/Rust AST and provenance pass. They do
not establish an agent speedup. Ruff has no Lua; the bridge pass is gated off,
and its complete edge count remains 266,071 on both builds.
SHA-256 comparisons of all non-timestamp node fields and every edge row also
match exactly between the preserved baseline and patched Ruff databases.

All three patched indexes retained their node **and edge** counts after another
unchanged re-index. No synthetic nodes are introduced.

Three independent questions were probed per corpus using the built public
`codegraph_explore` handler and graph APIs:

- Small: Lua `duplicate` into the native string helpers; `token.new` into
  `new_token`; the chunk-level `length` call into its Rust export. Six verified
  FFI edges now cross the language boundary, including bare `extern fn` exports
  with the default C ABI. Standard-library calls have no indexed target nodes.
- Medium: a command operation, a history operation, and derivation through a
  lexical module getter. All three reach their corresponding Rust handler.
  The history and derivation callers have no call path to the command handler.
  Reverse callers include the correct Lua source. The 80 edges comprise 72
  operation calls, six ordinary FFI calls, and two transport references.
- Large control: formatting, parsing, and lint-diagnostic production. Its
  existing graph is unchanged. Its flow summaries are **not** proof of complete
  Rust resolution: same-named methods and chained return-value calls still
  have coverage limitations.

The small corpus also exposes an existing missing ordinary Rust link from
`new_token` to its module-qualified constructor, and anonymous metatype
callbacks without an indexed owning function do not gain bridge edges. These
are coverage limits, separate from the verified FFI hop. Private source,
operation names, and answer transcripts are not part of this document.

## Automated checks

The full suite with the staged native kernel and
`CODEGRAPH_KERNEL=1 CODEGRAPH_KERNEL_EXPECT=1` passed: **6,124 tests passed,
34 skipped, 467 test files passed**. This includes the viewer project, fresh
compiled resolver-worker behavior, Lua/Rust kernel parity, and the existing
Lua/Luau resolution tests. TypeScript compilation and asset copying passed in
the test global setup.

The ten bridge/provenance/transport test files also passed with
`CODEGRAPH_KERNEL=0`: **169 tests passed**. They cover mutation and lexical
shadowing, captured/rebound namespaces, getter summaries, multiple forwarding
channels, same-line definitions, explicit exported ABI names, ambiguous
exports, Cargo/module identity, invocation and declarative macro proof,
cross-operation callers/impact, raw ABI usages, MCP annotations, viewer
rails/counts, and incremental Rust/Lua edits and deletions.

The unchanged upstream full suite was separately checked without a staged
kernel: 5,704 passed and 271 skipped. Its different skip count reflects native
kernel availability, not a removed test.

## Agent A/B status

The configured experiment contains nine questions, two repeats, and both
with/without-CodeGraph arms: 36 arm attempts. It uses the upstream
`scripts/agent-eval/run-all.sh`, Claude **Sonnet / high**, strict MCP configs,
the CLI-blocking hook/shim, and a verified warm daemon for each corpus.
Three corpora ran concurrently; prompts and repeats within each corpus were
sequential. The configuration, source fingerprints, commands, raw outputs,
test receipts, and ground truth are preserved in the local validation run.

**No valid A/B results were obtained.** All 36 attempts returned API 429 with
the account's weekly usage-limit message before any source or CodeGraph tool
call. Each Claude process exited 1. The result event had `is_error: true` even
though its `subtype` was `success`; the upstream metrics parser's `ok: true`
and shell harness exit 0 must not be accepted as a successful evaluation.
The validation driver checked the actual child exit and error event and
rejected every attempt. Reported durations are rejection latency, not task
performance. All three owned daemons were stopped successfully.

Keep this contribution in draft until the required repeated A/B can be run
and graded for answer correctness, duration, tool calls, Read/Grep, explore
budget, occupancy, sufficiency, allocation, and contamination. A large
positive Lua/Rust corpus has not been verified; Ruff provides a large control,
not that missing positive coverage.

The large control also retains an existing wrong same-name hop: the public
parser entry's `Parser::new().parse()` links to `mdtest`'s `Parser::parse`.
This edge was checked in the preserved original-main database and predates
the bridge. It remains an ordinary Rust resolver issue to address separately.

## Static-analysis boundary

The bridge recognizes proven LuaJIT FFI receivers and unique source-declared
C-ABI exports. It does not inspect runtime libraries or validate ABI layouts.
Known literal operations bypass shared transport; raw usages retain that
transport evidence. Semantic impact therefore does not establish ABI-change
isolation or complete runtime reachability.

Getter summaries require lexical local functions with one unconditional
namespace return. Branching/global/method getters, direct `return ffi.load`,
computed names, unknown operations and transforms, unindexed anonymous owners,
and chunk-level getter-member calls remain unresolved. Rust resolution does
not evaluate conditional compilation, procedural/nested macro expansion,
custom module paths, reexports/wildcards, external registry crates, or general
Cargo feature/target dependency configuration. Re-index after upgrading or
editing Cargo manifests.
