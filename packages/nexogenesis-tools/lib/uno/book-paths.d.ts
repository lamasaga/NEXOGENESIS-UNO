export const BOOK_STORAGE_LAYOUT: string;
export const BOOK_UNIT_REF: RegExp;
export const BOOK_ORIGINAL_REF: RegExp;
export const BOOK_ASSET_REF: RegExp;
export function isBookResource(ref: string): boolean;
export function isBookMaterialPath(ref: string): boolean;
export function bookExtractionBase(ref: string): string | null;
export function sameBookUnitSource(left: string, right: string): boolean;
