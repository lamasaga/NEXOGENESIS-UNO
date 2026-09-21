/** UNO-local overrides keep inherited credentials untouched and retain the native secret store. */
export const localCredentialRef = ref => 'UNO_LOCAL_' + ref;
export async function modelCredentialRef(ctx, ref, forWrite = false) {
  const local = localCredentialRef(ref);
  const override = await ctx.credentials.describe(local);
  if (override?.configured) return local;
  const original = await ctx.credentials.describe(ref);
  return forWrite && original?.writable === false ? local : ref;
}
export async function resolveModelCredential(ctx, ref) {
  return ctx.credentials.resolve(await modelCredentialRef(ctx, ref));
}
export async function saveModelCredential(ctx, ref, value) {
  await ctx.credentials.set(await modelCredentialRef(ctx, ref, true), value);
}
