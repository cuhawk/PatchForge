# CODEX_SPEC: PatchForge — TS/Node Taint Localizer, Minimal AST Patcher & 6-Stage Exploit/Differential Verifier

Build a serious TypeScript / Node 22+ static analysis + vulnerability repair verification engine (NO hand-wavy regexes pretending to be an analyzer, NO fabricated benchmarks).

## Required Architecture & Non-Trivial Invariants
1. **TypeScript Compiler API Parser & Module Graph (`src/analyzer/`):**
   - Real `ts.createProgram` + `ts.TypeChecker` analysis over multi-file TypeScript/JavaScript projects (resolving ESM/CJS imports, re-exports, `package.json` `exports`, and dynamic requires flagged when non-constant).
   - Versioned YAML rule specs (`rules/taint-ts.yaml` + `rules/install-hooks.yaml`) defining sources (`req.query`, `req.body`, `req.params`, `process.argv`, `mcp.toolArgs`), sanitizers (`path.resolve` + canonical `startsWith(base + path.sep)`, parameterized bindings, strict allowlists), and sinks (`child_process.exec`, `fs.readFile` path traversal, SSRF `fetch(tainted)`, SQL template interpolation, bracket lookup `obj[k]` prototype pollution).
   - Intra- & interprocedural taint propagation through `async/await`, `Promise.then`, destructuring, object spread, and helper functions with full taint trace nodes.
2. **SARIF 2.1.0 Output & Deterministic Ranking (`src/sarif/`):**
   - Emits valid SARIF 2.1.0 JSON with codeFlows/threadFlows showing source -> hops -> sink and deterministic confidence ranking.
   - Includes a clean **Pluggable Ranker / Ablation interface** comparing `deterministic-static` vs `template-ast-repair` (without calling paid external APIs at test time).
3. **Minimal AST-Edit Patch Synthesizer (`src/patcher/`):**
   - Emits targeted TypeScript/JS AST node transformations (using `typescript` AST printer / source span splicing — NEVER brittle string search-and-replace or free-form diffs):
     - Path traversal -> `path.resolve(baseDir, input)` + strict trailing-separator prefix boundary check + `fs.realpathSync` when file exists.
     - Command injection -> `execFileSync` / `execFile` with fixed arg array (`shell: false`).
     - Prototype pollution -> reject `__proto__`, `constructor`, `prototype` keys + `Object.create(null)` guard.
     - SSRF -> URL parse + protocol `https:` + private/link-local/metadata CIDR block check.
4. **6-Stage Verifier Harness (`src/verifier/`):**
   - Isolated runner executing:
     1. Original PoC exploit **MUST succeed pre-patch** (if PoC fails pre-patch, **PatchForge MUST refuse to emit/accept patch** with status `REFUSED_INVALID_POC` — critical correctness invariant!).
     2. Project benign unit tests pass pre-patch.
     3. Patch applied in isolated workspace copy; `tsc --noEmit` compiles cleanly.
     4. Original PoC exploit **MUST fail/block post-patch**.
     5. **Mutated variant exploits** (null bytes, `..\\..`, URL-encoded `%2e%2e%2f`, mixed delimiters, nested `__proto__` payload) **MUST also fail post-patch**.
     6. **Differential property checks** (using `fast-check`) comparing benign behavior pre-patch vs post-patch ensure functionality is preserved.
5. **Static Malicious `postinstall` Detector (`src/install_audit/`):**
   - Scans `package.json` lifecycle scripts + referenced JS files strictly statically (NEVER executes `npm install` scripts!) to flag download-and-exec (`curl|sh`, base64 `eval`, env var exfil).
6. **Realistic Benchmark Corpus & CI (`corpus/` + `benchmarks/run_bench.ts` + `.github/workflows/ci.yml`):**
   - Build a diverse benchmark suite under `corpus/` containing:
     - `15+` vulnerable multi-file TS/Node cases (path traversal, SSRF, command injection, prototype pollution, SQLi, unsafe `postinstall`),
     - `8` metamorphic obfuscated variants (wrapper indirection, destructured taint, renamed sink aliases, split strings),
     - `10` clean benign lookalike modules (`0` false positive expectation),
     - `2` intentionally non-reproducing invalid-PoC cases to verify `REFUSED_INVALID_POC` refusal behavior!
   - Actually run `npm test` + `npm run bench` (real execution!) and write exact observed numbers (`precision`, `recall`, `FPs on clean corpus`, `variant survival %`, `invalid-PoC refusals`, `median ms/file`) to `benchmarks/RESULTS.md`.
   - Document explicit failure modes (`eval`/`new Function`, monkey-patched globals, minified bundles) in `README.md` + `/rfcs/001-taint-and-verifier.md`.
   - **CRITICAL:** Run `git rm CODEX_SPEC.md` before finishing!
