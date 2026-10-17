/**
 * WMS endpoint capabilities: one GetCapabilities request, a dependency-free XML
 * reader and the document model the request planner needs (WMS-07..WMS-09).
 *
 * The parser reads the protocol subset of a capabilities document - elements,
 * attributes, CDATA and the five predefined entities. DOCTYPE declarations are
 * skipped without processing, so a document can never pull in external entities
 * or recursive definitions, and an unknown named entity stays literal text.
 */

import { assertArgument, fail, isMapletError } from '../api/errors.ts';
import type { GeoBounds } from '../math/bounds.ts';
import { WMS_REQUEST_CRS } from './raster.ts';

export type WmsCapabilitiesVersion = '1.1.1' | '1.3.0';

export interface WmsRequestDefaults {
  readonly version: WmsCapabilitiesVersion;
  /** A CRS this library can request correctly: CRS:84, EPSG:4326 or EPSG:3857. */
  readonly crs: string;
  /** A GetMap format the document declares, preferring `image/png`. */
  readonly format: string;
}

export interface WmsLayerNode {
  /** Request name; `undefined` for a grouping layer without a `<Name>`. */
  readonly name?: string;
  readonly title?: string;
  readonly abstract?: string;
  /** Own `queryable` attribute or the nearest declared ancestor's value. */
  readonly queryable: boolean;
  /** Declared CRS values plus inherited ones, normalized and unique. */
  readonly crs: readonly string[];
  /** Own or inherited geographic extent, when the document declares a usable one. */
  readonly bounds?: GeoBounds;
  readonly children: readonly WmsLayerNode[];
}

export interface WmsCapabilities {
  /** Document version; also the version a GetMap request should use. */
  readonly version: WmsCapabilitiesVersion;
  readonly title?: string;
  readonly abstract?: string;
  /** Every request CRS declared anywhere in the document, normalized and unique. */
  readonly crs: readonly string[];
  /** GetMap response formats declared by the document. */
  readonly formats: readonly string[];
  /** Service extent from the root layer, when usable. */
  readonly bounds?: GeoBounds;
  /** Top-level layers: the named service root layer, or its children. */
  readonly layers: readonly WmsLayerNode[];
  /**
   * GetMap options this document supports, ready to spread into `map.addWms`
   * next to a layer list. `undefined` when the endpoint declares no CRS this
   * library can request.
   */
  readonly preferred?: WmsRequestDefaults;
}

export interface WmsCapabilitiesFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** Transport for the GetCapabilities request; matches the Fetch API subset used. */
export type WmsCapabilitiesFetch = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<WmsCapabilitiesFetchResponse>;

export interface WmsCapabilitiesOptions {
  /** Transport override for tests and custom caching; defaults to `fetch`. */
  readonly fetchFn?: WmsCapabilitiesFetch;
  /** Abort the request; the returned promise rejects with `aborted`. */
  readonly signal?: AbortSignal;
}

/** GetCapabilities request URL; an existing query string is kept. */
export function wmsCapabilitiesUrl(url: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}service=WMS&request=GetCapabilities&version=1.3.0`;
}

const defaultFetch: WmsCapabilitiesFetch = (url, init) => {
  if (typeof fetch !== 'function') {
    fail('environment', 'WMS capabilities require a fetch() implementation', { url });
  }
  return fetch(url, { signal: init.signal }) as unknown as Promise<WmsCapabilitiesFetchResponse>;
};

export async function fetchWmsCapabilities(
  url: string,
  options: WmsCapabilitiesOptions = {},
): Promise<WmsCapabilities> {
  assertArgument(typeof url === 'string' && url.length > 0, 'wmsCapabilities requires a url');
  const fetchFn = options.fetchFn ?? defaultFetch;
  const signal = options.signal ?? new AbortController().signal;
  let response: WmsCapabilitiesFetchResponse;
  try {
    response = await fetchFn(wmsCapabilitiesUrl(url), { signal });
  } catch (error) {
    if (isMapletError(error)) throw error;
    if (options.signal?.aborted) fail('aborted', 'WMS GetCapabilities request aborted', { url });
    fail('import-invalid', `WMS GetCapabilities request failed: ${errorText(error)}`, { url });
  }
  if (!response.ok) {
    fail('import-invalid', `WMS GetCapabilities failed with HTTP ${response.status}`, {
      url,
      status: response.status,
    });
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    fail('import-invalid', `WMS GetCapabilities response could not be read: ${errorText(error)}`, { url });
  }
  return parseWmsCapabilities(text);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/* XML reader                                                                  */
/* -------------------------------------------------------------------------- */

interface XmlNode {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlNode[];
  text: string;
}

const MAX_DEPTH = 64;
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return ENTITIES[body] ?? match;
  });
}

/**
 * Reads well-formed XML into an element tree with lowercased local names.
 * Comments and processing instructions are dropped, CDATA becomes text, a
 * DOCTYPE declaration (including an internal subset) is skipped unprocessed and
 * namespace prefixes are stripped from element and attribute names.
 */
function parseXml(source: string): XmlNode {
  let index = 0;
  const length = source.length;

  const invalid = (message: string): never =>
    fail('import-invalid', `WMS capabilities: ${message}`, { offset: index });

  const skipSpace = (): void => {
    while (index < length) {
      const code = source.charCodeAt(index);
      if (code === 32 || code === 9 || code === 10 || code === 13) index++;
      else break;
    }
  };

  const skipComment = (): void => {
    const end = source.indexOf('-->', index);
    if (end < 0) invalid('unterminated comment');
    index = end + 3;
  };

  const skipInstruction = (): void => {
    const end = source.indexOf('?>', index);
    if (end < 0) invalid('unterminated processing instruction');
    index = end + 2;
  };

  const skipDoctype = (): void => {
    let bracket = 0;
    while (index < length) {
      const character = source[index];
      if (character === '[') bracket++;
      else if (character === ']') bracket = Math.max(0, bracket - 1);
      else if (character === '>' && bracket === 0) {
        index++;
        return;
      }
      index++;
    }
    invalid('unterminated doctype');
  };

  const readName = (): string => {
    const start = index;
    while (index < length) {
      const character = source[index]!;
      if (character === ' ' || character === '\t' || character === '\n' || character === '\r' ||
          character === '/' || character === '>' || character === '=') break;
      index++;
    }
    if (index === start) invalid('expected a name');
    return source.slice(start, index);
  };

  const localName = (name: string): string => {
    const colon = name.indexOf(':');
    return (colon < 0 ? name : name.slice(colon + 1)).toLowerCase();
  };

  const quoted = (): string => {
    const quote = source[index];
    if (quote !== '"' && quote !== "'") invalid('unquoted attribute value');
    const end = source.indexOf(quote!, index + 1);
    if (end < 0) invalid('unterminated attribute value');
    const value = decodeEntities(source.slice(index + 1, end));
    index = end + 1;
    return value;
  };

  const parseElement = (depth: number): XmlNode => {
    if (depth > MAX_DEPTH) invalid('element nesting is too deep');
    if (source[index] !== '<') invalid('expected an element');
    index++;
    const node: XmlNode = { name: localName(readName()), attributes: {}, children: [], text: '' };
    for (;;) {
      skipSpace();
      const character = source[index];
      if (character === undefined) invalid('unterminated element');
      if (character === '/') {
        index++;
        if (source[index] !== '>') invalid('expected ">" after "/"');
        index++;
        return node;
      }
      if (character === '>') {
        index++;
        break;
      }
      const attribute = localName(readName());
      skipSpace();
      if (source[index] !== '=') invalid('expected "=" after an attribute name');
      index++;
      skipSpace();
      node.attributes[attribute] = quoted();
    }
    for (;;) {
      if (index >= length) invalid(`unclosed element <${node.name}>`);
      if (source[index] !== '<') {
        const end = source.indexOf('<', index);
        const stop = end < 0 ? length : end;
        node.text += decodeEntities(source.slice(index, stop));
        index = stop;
        continue;
      }
      if (source.startsWith('</', index)) {
        index += 2;
        const closing = localName(readName());
        skipSpace();
        if (source[index] !== '>') invalid('expected ">" after a closing tag');
        index++;
        if (closing !== node.name) invalid(`mismatched closing tag </${closing}> for <${node.name}>`);
        return node;
      }
      if (source.startsWith('<!--', index)) {
        skipComment();
        continue;
      }
      if (source.startsWith('<![CDATA[', index)) {
        const end = source.indexOf(']]>', index);
        if (end < 0) invalid('unterminated CDATA section');
        node.text += source.slice(index + 9, end);
        index = end + 3;
        continue;
      }
      if (source.startsWith('<?', index)) {
        skipInstruction();
        continue;
      }
      node.children.push(parseElement(depth + 1));
    }
  };

  if (source.charCodeAt(0) === 0xfeff) index++;
  for (;;) {
    skipSpace();
    if (source.startsWith('<?', index)) skipInstruction();
    else if (source.startsWith('<!--', index)) skipComment();
    else if (source.startsWith('<!DOCTYPE', index)) skipDoctype();
    else break;
  }
  const root = parseElement(1);
  for (;;) {
    skipSpace();
    if (index >= length) break;
    if (source.startsWith('<!--', index)) skipComment();
    else invalid('unexpected content after the root element');
  }
  return root;
}

/* -------------------------------------------------------------------------- */
/* Capabilities model                                                          */
/* -------------------------------------------------------------------------- */

function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((candidate) => candidate.name === name);
}

function childList(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((candidate) => candidate.name === name);
}

function childText(node: XmlNode, name: string): string | undefined {
  const text = child(node, name)?.text.trim();
  return text ? text : undefined;
}

function numbers(values: readonly (string | undefined)[]): number[] | undefined {
  const out: number[] = [];
  for (const value of values) {
    if (value === undefined) return undefined;
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed)) return undefined;
    out.push(parsed);
  }
  return out;
}

/** One short form for `urn:ogc:def:crs:EPSG::4326`, an OGC URL and `epsg:4326`. */
function shortCrs(authority: string, code: string): string {
  const upperCode = code.toUpperCase();
  if (upperCode === 'CRS84') return 'CRS:84';
  return `${authority.toUpperCase()}:${upperCode}`;
}

function normalizeCrs(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const urn = /^urn:(?:x-)?ogc:def:crs:([a-z0-9]+)(?::[^:]*)?:([^:]+)$/i.exec(text);
  if (urn) return shortCrs(urn[1]!, urn[2]!);
  const url = /opengis\.net\/def\/crs\/([^/]+)\/[^/]*\/([^/?#]+)$/i.exec(text);
  if (url) return shortCrs(url[1]!, url[2]!);
  const short = /^([a-z0-9]+):(.+)$/i.exec(text);
  if (short) return shortCrs(short[1]!, short[2]!);
  return text;
}

function usableBounds(west: number, east: number, north: number, south: number): GeoBounds | undefined {
  if (!(east > west && north > south)) return undefined;
  return { southwest: { lat: south, lng: west }, northeast: { lat: north, lng: east } };
}

function layerBounds(element: XmlNode): GeoBounds | undefined {
  const geographic = child(element, 'ex_geographicboundingbox');
  if (geographic) {
    const values = numbers([
      childText(geographic, 'westboundlongitude'),
      childText(geographic, 'eastboundlongitude'),
      childText(geographic, 'southboundlatitude'),
      childText(geographic, 'northboundlatitude'),
    ]);
    if (values) return usableBounds(values[0]!, values[1]!, values[3]!, values[2]!);
  }
  const latLon = child(element, 'latlonboundingbox');
  if (latLon) {
    const values = numbers([latLon.attributes['minx'], latLon.attributes['miny'], latLon.attributes['maxx'], latLon.attributes['maxy']]);
    if (values) return usableBounds(values[0]!, values[2]!, values[3]!, values[1]!);
  }
  return undefined;
}

interface LayerContext {
  readonly crs: readonly string[];
  readonly queryable: boolean;
  readonly bounds: GeoBounds | undefined;
}

function layerNode(element: XmlNode, inherited: LayerContext): WmsLayerNode {
  const name = childText(element, 'name');
  const title = childText(element, 'title');
  const abstract = childText(element, 'abstract');
  const crs: string[] = [...inherited.crs];
  for (const source of [...childList(element, 'crs'), ...childList(element, 'srs')]) {
    for (const token of source.text.split(/[\s,]+/)) {
      const normalized = normalizeCrs(token);
      if (normalized && !crs.includes(normalized)) crs.push(normalized);
    }
  }
  const queryableAttribute = element.attributes['queryable'];
  const queryable =
    queryableAttribute === undefined
      ? inherited.queryable
      : queryableAttribute === '1' || queryableAttribute.toLowerCase() === 'true';
  const bounds = layerBounds(element) ?? inherited.bounds;
  const children = childList(element, 'layer').map((nested) => layerNode(nested, { crs, queryable, bounds }));
  return {
    ...(name ? { name } : {}),
    ...(title ? { title } : {}),
    ...(abstract ? { abstract } : {}),
    queryable,
    crs,
    ...(bounds ? { bounds } : {}),
    children,
  };
}

function preferredFormat(formats: readonly string[]): string {
  return (
    formats.find((format) => format === 'image/png') ??
    formats.find((format) => format.toLowerCase().startsWith('image/png')) ??
    formats.find((format) => format.toLowerCase().startsWith('image/')) ??
    'image/png'
  );
}

export function parseWmsCapabilities(source: string): WmsCapabilities {
  assertArgument(typeof source === 'string' && source.length > 0, 'capabilities text is required');
  const root = parseXml(source);
  if (root.name !== 'wms_capabilities' && root.name !== 'wmt_ms_capabilities') {
    fail('import-invalid', `not a WMS capabilities document (root <${root.name}>)`, { root: root.name });
  }
  const rawVersion = (root.attributes['version'] ?? '').trim();
  if (rawVersion !== '1.1.1' && rawVersion !== '1.3.0') {
    if (!rawVersion) fail('import-invalid', 'WMS capabilities document declares no version', {});
    fail('unsupported-capability', `WMS ${rawVersion} is not supported (1.1.1 and 1.3.0 are)`, {
      version: rawVersion,
    });
  }
  const version: WmsCapabilitiesVersion = rawVersion;
  const capability = child(root, 'capability');
  if (!capability) fail('import-invalid', 'WMS capabilities document has no <Capability>', {});
  const service = child(root, 'service');
  const request = child(capability, 'request');
  const getMap = request ? child(request, 'getmap') : undefined;
  const formats = getMap
    ? childList(getMap, 'format')
        .map((format) => format.text.trim())
        .filter(Boolean)
    : [];
  const rootLayer = child(capability, 'layer');
  if (!rootLayer) fail('import-invalid', 'WMS capabilities document has no root <Layer>', {});
  const parsed = layerNode(rootLayer, { crs: [], queryable: false, bounds: undefined });
  const crs: string[] = [];
  const visit = (node: WmsLayerNode): void => {
    for (const code of node.crs) if (!crs.includes(code)) crs.push(code);
    for (const nested of node.children) visit(nested);
  };
  visit(parsed);
  const title = service ? childText(service, 'title') : undefined;
  const abstract = service ? childText(service, 'abstract') : undefined;
  const preferredCrs = WMS_REQUEST_CRS.find((candidate) => crs.includes(candidate));
  return {
    version,
    ...(title ? { title } : {}),
    ...(abstract ? { abstract } : {}),
    crs,
    formats,
    ...(parsed.bounds ? { bounds: parsed.bounds } : {}),
    layers: parsed.name ? [parsed] : parsed.children,
    ...(preferredCrs === undefined
      ? {}
      : { preferred: { version, crs: preferredCrs, format: preferredFormat(formats) } }),
  };
}
