# CODEX_SPEC: PatchForge — TypeScript Compiler API Taint Analyzer, AST-Edit Repair & Differential Verifier

Build a serious TypeScript / Node 22+ static dataflow analysis + automated code-fix verification engine.

## Required Architecture & Non-Trivial Invariants
1. **TypeScript Compiler API Parser & Module Graph (`src/analyzer/`):**
   - Real `ts.createProgram` + `ts.TypeChecker` analysis over multi-file TypeScript/JavaScript projects (resolving ESM/CJS imports, re-exports, `package.json` `exports`, and dynamic requires flagged when non-constant).
   - Versioned YAML rule specs (`rules/taint-ts.yaml` + `rules/install-hooks.yaml`) defining untrusted sources (`req.query`, `req.body`, `req.params`, `process.argv`, `mcp.toolArgs`), validation guards (`path.resolve` + canonical `startsWith(base + path.sep)`, parameterized bindings, strict allowlists), and sensitive sinks (`child_process.exec`, `fs.readFile` traversal, outbound `fetch(untrustedUrl)`, SQL string interpolation, computed bracket key assignment `obj[k]` property contamination).
   - Intra- & interprocedural dataflow tracking through `async/await`, `Promise.then`, destructuring, object spread, and helper functions with full trace hops.
2. **SARIF 2.1.0 Output & Deterministic Ranking (`src/sarif/`):**
   - Emits valid SARIF 2.1.0 JSON with `codeFlows`/`threadFlows` showing source -> hops -> sink and deterministic confidence ranking.
   - Includes a clean pluggable Ranker / Ablation interface comparing `deterministic-static` vs `template-ast-repair` (without calling paid external APIs at test time).
3. **Minimal AST-Edit Fix Synthesizer (`src/patcher/`):**
   - Emits targeted TypeScript/JS AST node transformations (using `typescript` AST printer / source span splicing — NEVER brittle string regexes or free-form diffs):
     - Path validation -> `path.resolve(baseDir, input)` + strict trailing-separator prefix boundary check + `fs.realpathSync` when file exists.
     - Subprocess calls -> `execFileSync` / `execFile` with fixed arg array (`shell: false`).
     - Dynamic property key safety -> reject `__proto__`, `constructor`, `prototype` keys + `Object.create(null)` guard.
     - Outbound URL check -> URL parse + `https:` protocol + private/link-local/metadata CIDR deny check.
4. **6-Stage Differential & Regression Verifier Harness (`src/verifier/`):**
   - Isolated verification runner checking:
     1. Original failing regression test case **MUST fail/trigger pre-fix** (if the baseline failing test passes pre-fix, **PatchForge MUST refuse to emit/apply a fix** with status `REFUSED_NON_REPRODUCING_CASE` — critical correctness invariant!).
     2. Benign unit tests pass pre-fix.
     3. AST fix applied in isolated workspace copy; `tsc --noEmit` compiles cleanly.
     4. Original failing regression case **MUST pass/block unsafe input post-fix**.
     5. **Mutated bypass-regression inputs** (null bytes, `..\\..`, URL-encoded `%2e%2e%2f`, mixed delimiters, nested `__proto__` keys) **MUST also be blocked post-fix**.
     6. **Differential property checks** (using `fast-check`) comparing benign behavior pre-fix vs post-fix ensure functional compatibility is preserved.
5. **Static Lifecycle-Script Auditor (`src/install_audit/`):**
   - Scans `package.json` lifecycle scripts + referenced JS files strictly statically (NEVER runs lifecycle scripts!) to flag download-and-eval patterns, base64 decoding into `Function`/`eval`, and environment dumps.
6. **Realistic Benchmark Corpus & CI (`corpus/` + `benchmarks/run_bench.ts` + `.github/workflows/ci.yml`):**
   - Build a benchmark suite under `corpus/` containing:
     - `15+` vulnerable multi-file TS/Node regression cases (path validation, outbound URLs, subprocess calls, prototype safety, SQL interpolation, unsafe lifecycle scripts),
     - `8` semantics-preserving obfuscated variants (wrapper indirection, destructured flow, renamed helper aliases, split strings),
     - `10` clean benign lookalike modules (`0` false-positive expectation),
     - `2` non-reproducing invalid-baseline cases to verify `REFUSED_NON_REPRODUCING_CASE` refusal behavior!
   - Actually execute `npm test` + `npm run bench` (real execution!) and write ONLY actual observed metrics (`precision`, `recall`, `FPs on clean corpus`, `variant catch %`, `invalid-baseline refusals`, `median ms/file`) into `benchmarks/RESULTS.md`.
   - Document explicit limitations (`eval`/`new Function`, monkey-patched globals, minified bundles) in `README.md` + `/rfcs/001-taint-and-verifier.md`.
   - **CRITICAL:** Run `git rm CODEX_SPEC.md` before finishing!
