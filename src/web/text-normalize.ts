/**
 * Shared, dependency-free text normalization for matching playlist titles across
 * platforms. Lives under `web/` (rather than `core/`) because it has no Node-only
 * imports and must be servable as-is to the browser dashboard, which has no
 * bundler and can only load same-directory sibling modules. The core sync engine
 * (which can freely import across the compiled output) reuses this same module.
 */
export function normalizePlaylistName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}
