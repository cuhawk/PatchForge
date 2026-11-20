# PatchForge

PatchForge localizes configured TypeScript and JavaScript dataflows, emits SARIF 2.1.0, and proposes AST edits. It analyzes project source and npm lifecycle scripts statically.

## Development

```sh
npm install
npm run scan -- path/to/tsconfig.json path/to/package.json path/to/package-lock.json
npm run scan --silent -- --emit-diff --repair-config ./repair.json path/to/tsconfig.json
npx tsc --noEmit
npm test
npm run bench
```

## Library

Import the engine from `src/index.ts` in a TypeScript project. Pass project entry files and optional TypeScript compiler options to `analyze`. Use the compiler options from the target project's tsconfig to carry over custom paths and module settings. Pass the findings to `sarif` to serialize them with source and sink locations and stable structural fingerprints, or to `ablation` to compare static and repair-template ranking.

`auditInstallHooks` takes a path to a package manifest and inspects configured lifecycle scripts and local JavaScript references without executing scripts. `synthesize` takes the current file text, a finding, and explicit repair configuration. It returns source-span edits or an empty list when the finding falls outside its templates. Use `verify` to check a proposed edit through trusted callbacks and an in-memory TypeScript compilation. A passing baseline returns `REFUSED_NON_REPRODUCING_CASE` before the edit supplier runs. Verified edits can be passed to `applyEdits`.

Use `auditLockfile` or pass `package-lock.json` and `pnpm-lock.yaml` to the scanner. The audit checks SHA-512 digest format, immutable remote pins, internal registry hosts, and transitive lifecycle metadata using only lockfile contents. Pass `--lock-policy` with a JSON file such as `{"internalScopes":{"@company":["packages.example.test"]},"reviewedLifecycle":["builder@1.2.3"]}`. Internal host checks apply to configured scopes. Lifecycle coverage depends on the package manager recording script or build metadata.

`--emit-diff` writes a unified patch to standard output for inspection or `git apply`. Its repair configuration uses the same fields as `synthesize`, for example `{"guardsModule":"./guards.js","baseDirectory":"/reports"}`. The command leaves source files untouched and emits proposed edits for review.

The TypeScript analyzer follows resolved helper returns through `await`, `Promise.all` tuple positions, and promise callbacks. It follows payloads between statically resolved Node `EventEmitter` instances and listeners on known event names. Server Actions can opt in through a module-level or inline `"use server"` directive. PF007 reports missing runtime checks for required `string`, `number`, `boolean`, and `FormData` parameters. PF008 reports action input flowing into an outbound fetch. Set `allowedHosts` in the repair config to enable its URL template. It preserves fetch options and forces `redirect: "error"`. A `FormData` type guard checks the container. Application-specific validation still belongs with the action.

Run `npm run bench -- --write-results` to record a fresh observation in `benchmarks/RESULTS.md`. The benchmark uses inert source fixtures and runs two refusal checks. Precision and recall match findings to fixture-level rule expectations. Runtime includes program creation and is normalized by the number of files in each inspected fixture.

## Observed benchmark results

| Metric | Observed |
| --- | ---: |
| Precision | 100.00% |
| Recall | 100.00% |
| FPs on clean corpus | 0 |
| Invalid-baseline refusals | 2/2 |
| Median ms/file | 1.29 |

## Limitations

- The analyzer models a subset of TypeScript and JavaScript control flow and built-ins. Results can miss flows through loops, heap updates, custom guards, indirect callbacks, `eval`, `new Function`, monkey-patched globals, and minified bundles. Event delivery is modeled for known event names and analyzed registration and emission order. Dynamic events and delivery across independent entry points can be missed.
- The lifecycle auditor matches a subset of shell syntax and tracks selected values in referenced JavaScript. Script launchers and shell expansions can limit coverage.
- Repairs require explicit policy settings. The path guard requires an existing file and canonical base. Concurrent filesystem changes require protection at file-open time. URL repair accepts allowlisted public HTTPS IP literals on the default port, rejects reserved address ranges, and disables redirects. The subprocess template requires a configured executable and fixed arguments. Use an executable that accepts `--` followed by one data argument.
- The verifier runs trusted callbacks in the current process. It type-checks edited source in memory and compares benign observations using fast-check. Callers provide regression observations and samples.
