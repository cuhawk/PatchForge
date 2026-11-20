import { resolve } from "node:path";
import ts from "typescript";
import { analyze } from "./analyzer/index.js";
import { auditInstallHooks } from "./install_audit/index.js";
import { sarif } from "./sarif/index.js";

const inputs = process.argv.slice(2).map(file => resolve(file));
if (!inputs.length) throw new Error("Usage: npm run scan -- <tsconfig.json | source file | package.json> ...");
const sources = inputs.filter(input => /\.[cm]?[jt]sx?$/.test(input));
const manifests = inputs.filter(input => input.endsWith("/package.json"));
const configurations = inputs.filter(input => /\/tsconfig[^/]*\.json$/.test(input));
const findings = [...(sources.length ? analyze(sources) : []), ...manifests.flatMap(auditInstallHooks)];
for (const file of configurations) {
  const config = ts.getParsedCommandLineOfConfigFile(file, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
  });
  if (!config || config.errors.length) throw new Error(`Invalid TypeScript project: ${file}`);
  findings.push(...analyze(config.fileNames, config.options));
}
console.log(JSON.stringify(sarif(findings), null, 2));
