import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invalidateKnowledgeSnapshot } from '../../packages/nexogenesis-tools/lib/cards.js';

export function writeDomainFixture(root, id, title = id, parents = []) {
  const dir = join(root, '01-Cards', '_meta', 'domains');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\nkind: uno-domain-index\nid: "${id}"\ntitle: "${title}"\nparents: ${JSON.stringify(parents)}\nrepresentative_card_ids: []\nrelations: []\n---\n\n用于测试的长期知识问题空间。\n`, 'utf8');
  invalidateKnowledgeSnapshot(root);
}
