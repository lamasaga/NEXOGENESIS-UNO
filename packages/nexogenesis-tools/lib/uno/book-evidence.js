import { existsSync, readFileSync } from 'node:fs';
import { unoPath, sha } from '../harness/uno-storage.js';

const legacyMaterial = /^03-Archive\/books\/[a-f0-9]{64}\/[a-f0-9]{64}\/(?:catalog\.md|units\/c\d+-p\d+\.md|assets\/(?!\.{1,2}$)[a-zA-Z0-9._-]+)$/;
export function bookEvidenceRef(root, ref) {
  const original = unoPath(root, ref);
  if (!existsSync(original) && legacyMaterial.test(ref)) {
    const relocated = ref.replace(/^03-Archive\//, '05-Buffer/');
    if (existsSync(unoPath(root, relocated))) return relocated;
  }
  return ref;
}
export const bookEvidencePath = (root, ref) => unoPath(root, bookEvidenceRef(root, ref));
export function bookEvidenceRevision(root, ref) {
  const path = bookEvidencePath(root, ref);
  return existsSync(path) ? sha(readFileSync(path)) : null;
}
