export const BOOK_STORAGE_LAYOUT = 'buffer-book-units-v1';
export const BOOK_UNIT_REF = /^(?:05-Buffer|03-Archive)\/books\/([a-f0-9]{64})\/([a-f0-9]{64})\/units\/(c\d+-p\d+)\.md$/;
export const BOOK_ORIGINAL_REF = /^03-Archive\/books\/[a-f0-9]{64}\/original\.[a-z0-9]{1,10}$/;
export const BOOK_ASSET_REF = /^(?:05-Buffer|03-Archive)\/books\/[a-f0-9]{64}\/[a-f0-9]{64}\/assets\/(?!\.{1,2}$)[a-zA-Z0-9._-]+$/;
export const isBookResource = ref => BOOK_ORIGINAL_REF.test(ref) || BOOK_ASSET_REF.test(ref);
export const isBookMaterialPath = ref => /^(?:05-Buffer|03-Archive)\/books\//.test(ref);
export const bookExtractionBase = ref => BOOK_UNIT_REF.test(ref) ? ref.slice(0, ref.lastIndexOf('/units/')) : null;
export function sameBookUnitSource(left, right) {
  if (left === right) return true;
  const a = BOOK_UNIT_REF.exec(left), b = BOOK_UNIT_REF.exec(right);
  return !!a && !!b && a.slice(1).every((value, index) => value === b[index + 1]);
}
