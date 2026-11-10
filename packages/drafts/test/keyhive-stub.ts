// The plugin registry imports keyhive, which a page gets from its import map.
export function docIdFromAutomergeUrl(): never {
  throw new Error("keyhive isn't available in tests");
}
