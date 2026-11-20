# PatchForge

PatchForge localizes configured TypeScript and JavaScript dataflows, emits SARIF 2.1.0, and proposes AST edits. It analyzes project source and npm lifecycle scripts statically.

## Development

```sh
npm install
npx tsc --noEmit
npm test
npm run bench
```

## Library

Import the engine from `src/index.ts` in a TypeScript project. Pass project entry files and optional TypeScript compiler options to `analyze`. Use the compiler options from the target project's tsconfig to carry over custom paths and module settings. Pass the findings to `sarif` to serialize them with source and sink locations, or to `ablation` to compare static and repair-template ranking.

`auditInstallHooks` takes a path to a package manifest and inspects configured lifecycle scripts and local JavaScript references without executing scripts. `synthesize` takes the current file text, a finding, and explicit repair configuration. It returns source-span edits or an empty list when the finding falls outside its templates. Use `verify` to check a proposed edit through trusted callbacks and an in-memory TypeScript compilation. A passing baseline returns `REFUSED_NON_REPRODUCING_CASE` before the edit supplier runs. Verified edits can be passed to `applyEdits`.

The benchmark uses inert source fixtures and runs two refusal checks. Precision and recall match findings to fixture-level rule expectations. Runtime includes program creation and is normalized by the number of files in each inspected fixture.

## Limitations

- The analyzer models a subset of TypeScript and JavaScript control flow and built-ins. Results can miss flows through loops, heap updates, custom guards, indirect callbacks, `eval`, `new Function`, monkey-patched globals, and minified bundles.
- The lifecycle auditor matches a subset of shell syntax and tracks selected values in referenced JavaScript. Script launchers and shell expansions can limit coverage.
- Repairs require explicit policy settings. The path guard requires an existing file and canonical base. Concurrent filesystem changes require protection at file-open time. URL repair accepts configured HTTPS hostnames, rejects literal IPs and local hostname suffixes, and disables redirects. DNS address enforcement belongs at the network boundary. The subprocess template covers a fixed executable and one argument. Validate that argument against the executable's interface before adopting the edit.
- The verifier runs trusted callbacks in the current process. It type-checks edited source in memory and compares benign observations using fast-check. Callers provide regression observations and samples.
