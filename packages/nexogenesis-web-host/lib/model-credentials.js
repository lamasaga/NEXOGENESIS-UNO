import { createHash } from 'node:crypto';
/** UNO-local overrides keep inherited credentials untouched and retain the native secret store. */
export const localCredentialRef = ref => 'UNO_LOCAL_' + ref;
export const endpointCredentialRef = (ref,endpoint) => endpoint
  ? `${ref}_${createHash('sha256').update(String(endpoint).trim().replace(/\/+$/,'').toLowerCase()).digest('hex').slice(0,16).toUpperCase()}`
  : ref;
export async function modelCredentialRef(ctx, ref, forWrite = false) {
  if(typeof ctx.credentials?.describe!=='function')return ref;
  const local = localCredentialRef(ref);
  const override = await ctx.credentials.describe(local);
  if (override?.configured) return local;
  const original = await ctx.credentials.describe(ref);
  return forWrite && original?.writable === false ? local : ref;
}
export async function resolveModelCredential(ctx, ref, { endpoint } = {}) {
  const scoped=endpointCredentialRef(ref,endpoint);
  if(scoped!==ref&&typeof ctx.credentials?.describe==='function'){
    const target=await modelCredentialRef(ctx,scoped);
    if((await ctx.credentials.describe(target))?.configured)return ctx.credentials.resolve(target);
  }
  return ctx.credentials.resolve(await modelCredentialRef(ctx,ref));
}
export async function saveModelCredential(ctx, ref, value, { endpoint } = {}) {
  const scoped=endpointCredentialRef(ref,endpoint);
  await ctx.credentials.set(await modelCredentialRef(ctx,scoped,true),value);
}
