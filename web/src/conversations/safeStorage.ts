const memory = new Map<string, string | null>();
const unsaved = new Set<string>();
function warn() { if (typeof window !== 'undefined') window.dispatchEvent(new Event('uno-storage-unavailable')); }
const keyFor = (kind: 'localStorage' | 'sessionStorage', key: string) => `${kind}:${key}`;
export function readStorage(kind: 'localStorage' | 'sessionStorage', key: string): string | null {
  const id=keyFor(kind,key);
  if (unsaved.has(id)) return memory.get(id) ?? null;
  try { const value=globalThis[kind].getItem(key); memory.set(id,value); return value; }
  catch { warn(); return memory.get(id) ?? null; }
}
export function writeStorage(kind: 'localStorage' | 'sessionStorage', key: string, value: string): boolean {
  const id=keyFor(kind,key);memory.set(id,value);
  try { globalThis[kind].setItem(key,value);unsaved.delete(id);return true; }
  catch { unsaved.add(id);warn();return false; }
}
export function resetStorageMemoryForTests() { memory.clear();unsaved.clear(); }
