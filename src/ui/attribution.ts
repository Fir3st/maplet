/**
 * Attribution notice collection (UI-03).
 *
 * The notice is derived from the current scene state, not from a second model:
 * only sources referenced by at least one layer contribute, equal strings are
 * deduplicated (first occurrence wins), and a notice shared by several sources
 * stays while any of them remains.
 */

export interface AttributionSource {
  readonly sourceId: string;
  readonly attribution: string | null | undefined;
}

export interface AttributionLayerRef {
  readonly sourceId: string;
}

/** Deduplicates trimmed non-empty strings, preserving first-seen order. */
export function dedupeAttributions(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = value?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

/** Attribution strings of sources that are currently used by at least one layer. */
export function attributionsForLayers(
  sources: readonly AttributionSource[],
  layers: readonly AttributionLayerRef[],
): string[] {
  const used = new Set(layers.map((layer) => layer.sourceId));
  return dedupeAttributions(
    sources.filter((source) => used.has(source.sourceId)).map((source) => source.attribution),
  );
}
