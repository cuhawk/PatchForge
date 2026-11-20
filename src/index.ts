export { analyze } from './analyzer/index.js';
export { auditInstallHooks } from './install_audit/index.js';
export { ablation, deterministicStatic, rank, sarif, templateAstRepair } from './sarif/index.js';
export { applyEdits, synthesize } from './patcher/index.js';
export { verify } from './verifier/index.js';
export type { Finding, Site } from './model.js';
export { auditLockfile, type LockfilePolicy } from './lockfile/index.js';
export { emitDiff } from './patcher/diff.js';
