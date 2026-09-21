import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetLocalRequestTokenForTests, uploadInboxInBatches } from './client';

afterEach(() => { vi.unstubAllGlobals(); __resetLocalRequestTokenForTests(); });
function transport(reply: (files: File[], call: number) => unknown) {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/security/session') return new Response(JSON.stringify({token: 'test-token'}));
    expect(new Headers(init?.headers).get('X-Nexogenesis-Instance')).toBe('default');
    const files = (init?.body as FormData).getAll('files') as File[];
    return new Response(JSON.stringify(reply(files, ++calls)));
  }));
  return () => calls;
}
const receipt = (files: File[]) => ({saved: files.map(f => f.name), items: files.map((f, index) => ({index, name: f.name, status: 'saved'}))});

describe('bounded Inbox import', () => {
  it('imports all 1400 files in bounded groups without dropping the final group', async () => {
    const calls = transport(files => { expect(files.length).toBeLessThanOrEqual(24); return receipt(files); });
    const states: number[] = [];
    const result = await uploadInboxInBatches(Array.from({length: 1400}, (_, i) => new File(['正文'], `${i}.md`)), 'default', p => states.push(p.completed));
    expect(result.saved).toBe(1400); expect(result.failed).toEqual([]); expect(result.completed).toBe(1400);
    expect(calls()).toBe(59); expect(states.at(-1)).toBe(1400);
  });
  it('accounts for a failed request and continues, then retries only uncertain files', async () => {
    const calls = transport((files, call) => { if (call === 2) throw new Error('network lost'); return receipt(files); });
    const files = Array.from({length: 53}, (_, i) => new File(['正文'], `${i}.md`));
    const result = await uploadInboxInBatches(files, 'default', () => {});
    expect(result.saved).toBe(29); expect(result.failed).toHaveLength(24); expect(result.completed).toBe(53);
    expect(result.failed[0].file).toBe(files[24]); expect(calls()).toBe(3);
    const retried = await uploadInboxInBatches(result.failed.map(item => item.file), 'default', () => {});
    expect(retried.saved).toBe(24); expect(retried.failed).toEqual([]); expect(calls()).toBe(4);
  });
  it('accepts a 200 MiB file as its own request, rejects only above 256 MiB, and groups smaller files by bytes', async () => {
    const calls = transport(files => { expect(files.length).toBe(1); return receipt(files); });
    const files = [new File([new Uint8Array(5 * 1024 * 1024)], 'a.pdf'), new File([new Uint8Array(5 * 1024 * 1024)], 'b.pdf'), new File(['large'], 'large.pdf'), new File(['x'], 'too-large.pdf')];
    Object.defineProperty(files[2], 'size', {value: 200 * 1024 * 1024});
    Object.defineProperty(files[3], 'size', {value: 257 * 1024 * 1024});
    const result = await uploadInboxInBatches(files, 'default', () => {});
    expect(result.saved).toBe(3); expect(result.failed).toHaveLength(1); expect(result.completed).toBe(4); expect(calls()).toBe(3);
  });
  it('missing or duplicate receipts are never reported as a successful import', async () => {
    transport(() => ({saved: ['a.md', 'b.md'], items: [{index: 0, status: 'saved'}, {index: 0, status: 'saved'}]}));
    const result = await uploadInboxInBatches([new File(['a'], 'a.md'), new File(['b'], 'b.md')], 'default', () => {});
    expect(result.saved).toBe(0); expect(result.failed).toHaveLength(2);
  });
});
