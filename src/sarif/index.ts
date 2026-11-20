import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import type { Finding, Site } from '../model.js';

export interface Ranker {
  id: string;
  score(finding: Finding): number;
}

export const deterministicStatic: Ranker = { id: 'deterministic-static', score: finding => finding.confidence };

export function templateAstRepair(canRepair: (finding: Finding) => boolean): Ranker {
  return { id: 'template-ast-repair', score: finding => finding.confidence + (canRepair(finding) ? 0.01 : 0) };
}

export function rank(findings: readonly Finding[], ranker = deterministicStatic): Finding[] {
  return [...findings].sort((a, b) => ranker.score(b) - ranker.score(a) ||
    a.sink.file.localeCompare(b.sink.file, 'en') || a.sink.start - b.sink.start || a.ruleId.localeCompare(b.ruleId, 'en'));
}

export function ablation(findings: readonly Finding[], candidate: Ranker) {
  return [deterministicStatic, candidate].map(ranker => ({ ranker: ranker.id, findings: rank(findings, ranker) }));
}

export function sarif(findings: readonly Finding[], root = process.cwd(), ranker = deterministicStatic) {
  const location = (point: Site) => ({
    physicalLocation: {
      artifactLocation: { uri: relative(root, resolve(point.file)).split(/[\\/]/).map(encodeURIComponent).join('/') },
      region: { startLine: point.line, startColumn: point.column, endLine: point.endLine, endColumn: point.endColumn },
    },
    message: { text: point.message },
  });
  const rules = [...new Set(findings.map(finding => finding.ruleId))].sort().map(id => ({ id }));
  return {
    $schema: 'https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0-rtm.5.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'PatchForge', rules } },
      results: rank(findings, ranker).map(finding => ({
        ruleId: finding.ruleId, ruleIndex: rules.findIndex(rule => rule.id === finding.ruleId),
        level: 'warning', message: { text: finding.sink.message }, locations: [location(finding.sink)],
        partialFingerprints: {
          'primaryLocationLineHash/v1': createHash('sha256')
            .update(JSON.stringify([finding.ruleId, finding.sink.message, finding.fingerprintContext]))
            .digest('hex'),
        },
        codeFlows: [{ threadFlows: [{ locations: [...finding.trace, finding.sink].map(point => ({ location: location(point) })) }] }],
        properties: { confidence: finding.confidence, ranker: ranker.id },
      })),
    }],
  };
}
