import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";
import { analyze } from "./analyzer/index.js";
import { auditInstallHooks } from "./install_audit/index.js";
import { auditLockfile, type LockfilePolicy } from "./lockfile/index.js";
import { synthesize, type Edit, type RepairOptions } from "./patcher/index.js";
import { emitDiff } from "./patcher/diff.js";
import { rank, sarif } from "./sarif/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "emit-diff": { type: "boolean" },
    "repair-config": { type: "string" },
    "lock-policy": { type: "string" },
  },
});
const inputs = [...new Set(positionals.map(file => resolve(file)))];
if (!inputs.length) throw new Error("Usage: npm run scan -- [--emit-diff --repair-config FILE] [--lock-policy FILE] <input> ...");
const sources = inputs.filter(input => /\.[cm]?[jt]sx?$/.test(input));
const manifests = inputs.filter(input => basename(input) === "package.json");
const locks = inputs.filter(input => ["package-lock.json", "pnpm-lock.yaml"].includes(basename(input)));
const configurations = inputs.filter(input => /^tsconfig[^/]*\.json$/.test(basename(input)));
const policy: LockfilePolicy = values["lock-policy"] ? JSON.parse(readFileSync(values["lock-policy"], "utf8")) : {};
const findings = [...(sources.length ? analyze(sources) : []), ...manifests.flatMap(auditInstallHooks),
  ...locks.flatMap(file => auditLockfile(file, policy))];
for (const file of configurations) {
  const config = ts.getParsedCommandLineOfConfigFile(file, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
  });
  if (!config || config.errors.length) throw new Error(`Invalid TypeScript project: ${file}`);
  findings.push(...analyze(config.fileNames, config.options));
}

if (values["emit-diff"]) {
  if (!values["repair-config"]) throw new Error("--emit-diff requires --repair-config FILE");
  const options: RepairOptions = JSON.parse(readFileSync(values["repair-config"], "utf8"));
  if (typeof options.guardsModule !== "string" || !options.guardsModule) throw new Error("A guardsModule string is required");
  const files = new Map<string, { input: string; edits: Edit[]; aliases: string[] }>();
  for (const finding of rank(findings)) {
    if (!["PF001", "PF002", "PF003", "PF005", "PF007", "PF008"].includes(finding.ruleId)) continue;
    const file = resolve(finding.sink.file);
    let plan = files.get(file);
    if (!plan) {
      plan = { input: readFileSync(file, "utf8"), edits: [], aliases: [] };
      files.set(file, plan);
    }
    const edits = synthesize(plan.input, finding, options, plan.aliases);
    if (edits.some(edit => plan.edits.some(existing =>
      edit.start < existing.end && existing.start < edit.end))) continue;
    for (const edit of edits) {
      if (plan.edits.some(existing => existing.start === edit.start && existing.end === edit.end &&
          existing.replacement === edit.replacement)) continue;
      const alias = /^import .* as (__patchforge\d+) /m.exec(edit.replacement)?.[1];
      if (alias) plan.aliases.push(alias);
      plan.edits.push(edit);
    }
  }
  process.stdout.write([...files].map(([file, { input, edits }]) => emitDiff(file, input, edits)).join(""));
} else {
  console.log(JSON.stringify(sarif(findings), null, 2));
}
