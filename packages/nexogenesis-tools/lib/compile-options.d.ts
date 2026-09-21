export const COMPILE_HINTS: Array<{id:string;label:string;prompt:string}>;
export function parseCompileCommand(text: string): {notes:string}|null;
