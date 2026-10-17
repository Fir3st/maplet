import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  fetchWmsCapabilities,
  parseWmsCapabilities,
  wmsCapabilitiesUrl,
} from '../../src/formats/wms-capabilities.ts';
import { isMapletError } from '../../src/api/errors.ts';

/** A 1.3.0 document shaped like a real endpoint: nested groups, URN CRS values. */
const V130 = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Service>
    <Name>WMS</Name>
    <Title>Základní mapa &amp; okolí</Title>
    <Abstract><![CDATA[Base layers: <boundaries>, parcels & buildings.]]></Abstract>
  </Service>
  <Capability>
    <Request>
      <GetMap>
        <Format>image/jpeg</Format>
        <Format>image/png</Format>
      </GetMap>
      <GetFeatureInfo><Format>text/html</Format></GetFeatureInfo>
    </Request>
    <Layer>
      <Title>Service root</Title>
      <CRS>urn:ogc:def:crs:EPSG::3857</CRS>
      <EX_GeographicBoundingBox>
        <westBoundLongitude>14.15</westBoundLongitude>
        <eastBoundLongitude>14.75</eastBoundLongitude>
        <southBoundLatitude>49.90</southBoundLatitude>
        <northBoundLatitude>50.25</northBoundLatitude>
      </EX_GeographicBoundingBox>
      <Layer queryable="1">
        <Name>0</Name>
        <Title>Boundaries</Title>
        <CRS>EPSG:4326</CRS>
        <CRS>CRS:84</CRS>
        <Layer>
          <Name>17</Name>
          <Title>Districts</Title>
          <CRS>http://www.opengis.net/def/crs/EPSG/0/5514</CRS>
        </Layer>
      </Layer>
      <Layer>
        <Name>8</Name>
        <Title>Buildings</Title>
      </Layer>
      <Layer queryable="0">
        <Name></Name>
        <Title>Empty name group</Title>
        <Layer>
          <Name>alt</Name>
          <Title>Alternative</Title>
        </Layer>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

const V111 = `<?xml version="1.0" encoding="UTF-8"?>
<WMT_MS_Capabilities version="1.1.1">
  <Service>
    <Title>Legacy grid service</Title>
    <Abstract>An old service.</Abstract>
  </Service>
  <Capability>
    <Request><GetMap><Format>image/png8</Format></GetMap></Request>
    <Layer>
      <Title>Root</Title>
      <SRS>EPSG:4326 EPSG:3857 EPSG:5514</SRS>
      <LatLonBoundingBox minx="14.1" miny="49.8" maxx="14.9" maxy="50.4" />
      <Layer queryable="1">
        <Name>grid</Name>
        <Title>Grid &amp; labels</Title>
      </Layer>
    </Layer>
  </Capability>
</WMT_MS_Capabilities>`;

test('WMS-07: a 1.3.0 document yields layers, CRS, formats and defaults', () => {
  const capabilities = parseWmsCapabilities(V130);
  assert.equal(capabilities.version, '1.3.0');
  assert.equal(capabilities.title, 'Základní mapa & okolí', 'entities decode');
  assert.equal(capabilities.abstract, 'Base layers: <boundaries>, parcels & buildings.', 'CDATA is text');
  assert.deepEqual(capabilities.formats, ['image/jpeg', 'image/png'], 'only GetMap formats');
  assert.deepEqual(capabilities.bounds, {
    southwest: { lat: 49.9, lng: 14.15 },
    northeast: { lat: 50.25, lng: 14.75 },
  });

  // The unnamed root layer contributes crs and bounds, not a layer entry.
  assert.deepEqual(capabilities.layers.map((layer) => layer.name), ['0', '8', undefined]);
  const boundaries = capabilities.layers[0]!;
  assert.equal(boundaries.title, 'Boundaries');
  assert.equal(boundaries.queryable, true, 'the queryable attribute inherits');
  assert.deepEqual(boundaries.crs, ['EPSG:3857', 'EPSG:4326', 'CRS:84'], 'declared plus inherited, normalized');
  const districts = boundaries.children[0]!;
  assert.equal(districts.name, '17');
  assert.deepEqual(districts.crs, ['EPSG:3857', 'EPSG:4326', 'CRS:84', 'EPSG:5514'], 'child CRS adds to inherited');
  assert.deepEqual(districts.bounds, capabilities.bounds, 'bounds inherit');
  const group = capabilities.layers[2]!;
  assert.equal(group.name, undefined, 'an empty <Name> is still a group');
  assert.equal(group.queryable, false, 'no declared flag defaults to not queryable');
  assert.deepEqual(group.children.map((layer) => layer.name), ['alt'], 'a group keeps its children');

  // Service-level union in document order, with URN and OGC URL forms normalized.
  assert.deepEqual(capabilities.crs, ['EPSG:3857', 'EPSG:4326', 'CRS:84', 'EPSG:5514']);
  assert.deepEqual(capabilities.preferred, { version: '1.3.0', crs: 'CRS:84', format: 'image/png' });
});

test('WMS-07: a 1.1.1 document uses SRS lists and LatLonBoundingBox', () => {
  const capabilities = parseWmsCapabilities(V111);
  assert.equal(capabilities.version, '1.1.1');
  assert.equal(capabilities.title, 'Legacy grid service');
  assert.deepEqual(capabilities.formats, ['image/png8']);
  assert.deepEqual(capabilities.bounds, {
    southwest: { lat: 49.8, lng: 14.1 },
    northeast: { lat: 50.4, lng: 14.9 },
  });
  const grid = capabilities.layers[0]!;
  assert.equal(grid.name, 'grid');
  assert.equal(grid.title, 'Grid & labels');
  assert.deepEqual(grid.crs, ['EPSG:4326', 'EPSG:3857', 'EPSG:5514'], 'a space-separated SRS list splits');
  assert.equal(grid.queryable, true);
  // CRS:84 is not declared, so the next requestable value wins; the png variant
  // is used because no exact image/png is on the list.
  assert.deepEqual(capabilities.preferred, { version: '1.1.1', crs: 'EPSG:4326', format: 'image/png8' });
});

test('WMS-08: OGC CRS:84 spellings normalize to the same code', () => {
  const capabilities = parseWmsCapabilities(`<WMS_Capabilities version="1.3.0"><Capability><Layer>
    <CRS>urn:ogc:def:crs:OGC:1.3:CRS84</CRS>
    <CRS>http://www.opengis.net/def/crs/OGC/0/CRS84</CRS>
    <CRS>EPSG:4326</CRS>
    <Layer><Name>l</Name></Layer>
  </Layer></Capability></WMS_Capabilities>`);
  assert.deepEqual(capabilities.crs, ['CRS:84', 'EPSG:4326'], 'URN and URL spellings collapse into one code');
  assert.equal(capabilities.preferred?.crs, 'CRS:84');
});

test('WMS-08: a named root layer stays the single top-level layer', () => {
  const capabilities = parseWmsCapabilities(`<WMS_Capabilities version="1.3.0"><Capability><Layer>
    <Name>service</Name><Title>Whole service</Title>
    <CRS>EPSG:3857</CRS>
    <Layer><Name>roads</Name></Layer>
  </Layer></Capability></WMS_Capabilities>`);
  assert.deepEqual(capabilities.layers.map((layer) => layer.name), ['service']);
  assert.deepEqual(capabilities.layers[0]!.children.map((layer) => layer.name), ['roads']);
  assert.deepEqual(capabilities.preferred, { version: '1.3.0', crs: 'EPSG:3857', format: 'image/png' });
});

test('WMS-08: the default CRS follows CRS:84, EPSG:4326, EPSG:3857 and the format is a declared image', () => {
  const pick = (crs: string, formats = '<Format>image/png</Format>') =>
    parseWmsCapabilities(
      `<WMS_Capabilities version="1.3.0"><Capability><Request><GetMap>${formats}</GetMap></Request>` +
        `<Layer><CRS>${crs}</CRS><Layer><Name>l</Name></Layer></Layer></Capability></WMS_Capabilities>`,
    );
  assert.equal(pick('EPSG:3857').preferred?.crs, 'EPSG:3857');
  assert.equal(pick('EPSG:3857 EPSG:4326').preferred?.crs, 'EPSG:4326', 'without CRS:84, EPSG:4326 wins');
  assert.equal(pick('EPSG:4326').preferred?.crs, 'EPSG:4326');
  assert.equal(
    parseWmsCapabilities(`<WMS_Capabilities version="1.3.0"><Capability><Layer>
      <CRS>CRS:84</CRS><CRS>EPSG:4326</CRS><Layer><Name>l</Name></Layer>
    </Layer></Capability></WMS_Capabilities>`).preferred?.crs,
    'CRS:84',
    'CRS:84 avoids the axis trap, so it wins over EPSG:4326',
  );
  const none = pick('EPSG:5514 EPSG:102067');
  assert.equal(none.preferred, undefined, 'a Krovak-only endpoint offers no requestable default');
  assert.deepEqual(none.crs, ['EPSG:5514', 'EPSG:102067'], 'but its CRS are still reported');
  assert.equal(pick('EPSG:5514', '<Format>image/jpeg</Format>').preferred, undefined);
  assert.equal(
    parseWmsCapabilities(
      `<WMS_Capabilities version="1.3.0"><Capability><Request><GetMap><Format>application/geo+json</Format></GetMap></Request>` +
        `<Layer><CRS>EPSG:4326</CRS><Layer><Name>l</Name></Layer></Layer></Capability></WMS_Capabilities>`,
    ).preferred?.format,
    'image/png',
    'with no declared image format the builder default is requested',
  );
});

test('WMS-09: malformed or foreign documents fail with import-invalid', () => {
  const failures: [string, RegExp][] = [
    ['<WMS_Capabilities version="1.3.0"><Capability></WMS_Capabilities>', /mismatched closing tag/],
    ['<html><body>Not a service</body></html>', /not a WMS capabilities document/],
    ['<WMS_Capabilities><Capability><Layer/></Capability></WMS_Capabilities>', /no version/],
    ['<WMS_Capabilities version="1.3.0"><Capability/></WMS_Capabilities>', /no root <Layer>/],
  ];
  for (const [document, message] of failures) {
    assert.throws(
      () => parseWmsCapabilities(document),
      (error: unknown) => isMapletError(error) && error.code === 'import-invalid' && message.test(error.message),
      document.slice(0, 40),
    );
  }
  assert.throws(
    () => parseWmsCapabilities('<WMS_Capabilities version="1.0.0"><Capability><Layer/></Capability></WMS_Capabilities>'),
    (error: unknown) => isMapletError(error) && error.code === 'unsupported-capability',
  );
});

test('WMS-09: entities in a DOCTYPE are never expanded and namespaced documents parse', () => {
  const doctype = `<?xml version="1.0"?>
<!DOCTYPE WMS_Capabilities [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<WMS_Capabilities version="1.3.0"><Service><Title>&xxe;</Title></Service>
<Capability><Layer><Layer><Name>l</Name><Title>&unknown;</Title></Layer></Layer></Capability></WMS_Capabilities>`;
  const capabilities = parseWmsCapabilities(doctype);
  assert.equal(capabilities.title, '&xxe;', 'an unresolved entity stays literal text');
  assert.equal(capabilities.layers[0]!.title, '&unknown;');

  const namespaced = parseWmsCapabilities(`<wms:WMS_Capabilities version="1.3.0" xmlns:wms="http://www.opengis.net/wms">
    <wms:Capability><wms:Layer><wms:CRS>EPSG:4326</wms:CRS><wms:Layer><wms:Name>roads</wms:Name></wms:Layer></wms:Layer></wms:Capability>
  </wms:WMS_Capabilities>`);
  assert.equal(namespaced.layers[0]!.name, 'roads');
  assert.equal(namespaced.preferred?.crs, 'EPSG:4326');

  // A comment and a degenerate bounding box are tolerated without inventing bounds.
  const degenerate = parseWmsCapabilities(`<WMS_Capabilities version="1.3.0"><Capability>
    <!-- the service extent is unknown -->
    <Layer><LatLonBoundingBox minx="0" miny="0" maxx="0" maxy="0"/><Layer><Name>l</Name></Layer></Layer>
  </Capability></WMS_Capabilities>`);
  assert.equal(degenerate.bounds, undefined);
});

test('WMS-09: the fetcher builds the request URL and maps transport failures', async () => {
  assert.equal(
    wmsCapabilitiesUrl('https://wms.example/ows'),
    'https://wms.example/ows?service=WMS&request=GetCapabilities&version=1.3.0',
  );
  assert.equal(
    wmsCapabilitiesUrl('https://wms.example/ows?map=a.map'),
    'https://wms.example/ows?map=a.map&service=WMS&request=GetCapabilities&version=1.3.0',
    'an existing query string is kept',
  );

  const calls: string[] = [];
  const capabilities = await fetchWmsCapabilities('https://wms.example/ows', {
    fetchFn: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => V130 };
    },
  });
  assert.deepEqual(calls, ['https://wms.example/ows?service=WMS&request=GetCapabilities&version=1.3.0']);
  assert.equal(capabilities.title, 'Základní mapa & okolí');

  await assert.rejects(
    fetchWmsCapabilities('https://wms.example/ows', {
      fetchFn: async () => ({ ok: false, status: 404, text: async () => 'nope' }),
    }),
    (error: unknown) =>
      isMapletError(error) && error.code === 'import-invalid' && error.detail['status'] === 404,
  );
  await assert.rejects(
    fetchWmsCapabilities('https://wms.example/ows', {
      fetchFn: async () => {
        throw new TypeError('Failed to fetch');
      },
    }),
    (error: unknown) =>
      isMapletError(error) && error.code === 'import-invalid' && /Failed to fetch/.test(error.message),
  );
  await assert.rejects(
    fetchWmsCapabilities('https://wms.example/ows', {
      fetchFn: async () => {
        throw new Error('aborted');
      },
      signal: AbortSignal.abort(),
    }),
    (error: unknown) => isMapletError(error) && error.code === 'aborted',
  );
});

test('WMS-09: without a fetch implementation the fetcher reports the environment', async () => {
  const original = globalThis.fetch;
  // @ts-expect-error: deleting the global fetch exercises the environment guard.
  delete globalThis.fetch;
  try {
    await assert.rejects(
      fetchWmsCapabilities('https://wms.example/ows'),
      (error: unknown) => isMapletError(error) && error.code === 'environment',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('WMS-09: the committed legacy fixture parses as a Krovak-only endpoint', () => {
  const document = readFileSync(fileURLToPath(new URL('../../demo/wms-legacy.xml', import.meta.url)), 'utf8');
  const capabilities = parseWmsCapabilities(document);
  assert.equal(capabilities.version, '1.1.1');
  assert.equal(capabilities.preferred, undefined);
  assert.deepEqual(capabilities.crs, ['EPSG:5514']);
});
