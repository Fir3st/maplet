# Discover a WMS endpoint

A WMS service publishes its layers, coordinate systems and formats in one
GetCapabilities document. Maplet can read that document for you and turn the
answer into a GetMap request, so an endpoint URL is all you need to bring a real
service onto the map. The example uses a live Czech service: Prague's **Základní
mapa** (base map) published by IPR Praha.

## From an endpoint to pixels

```ts
const capabilities = await map.data.wmsCapabilities(serviceUrl);
// capabilities.layers  - the nested layer tree with titles and flags
// capabilities.crs     - every declared CRS, normalized
// capabilities.formats - the GetMap formats the service declares
// capabilities.bounds  - the service extent, when it declares one
// capabilities.preferred = { version, crs, format }  - a request it supports

map.addWms(serviceUrl, {
  id: 'service',
  layers: '6,8,17,19,20',
  ...capabilities.preferred,
  attribution: '© IPR Praha',
});
```

`wmsCapabilities(url)` requests `GetCapabilities` in WMS 1.3.0 and accepts both
1.3.0 and 1.1.1 documents (a server that only speaks 1.1.1 answers with its own
version and that version is what `preferred` reports). `preferred` is absent when
the endpoint declares no CRS this library can request: BBOX support covers
`CRS:84`, `EPSG:4326` and `EPSG:3857`, so a service that only offers a national
grid is reported, not silently requested with wrong coordinates. The same rule
applies to `map.data.wms()` and to `update({ crs })`: an unsupported CRS fails
with `invalid-argument` instead of producing a wrong map.

## Live example

The example discovers the live service, opens on central Prague at a zoom where
the service's detail layers draw, and requests only the checked layers. Changing
a checkbox calls `setParams()`; the previous tiles stay visible until their
replacements decode. The action fits the extent the document declares — this
base map is a city service, so far-away views stay sparse by design. The
endpoint needs a network connection and is published under IPR Praha's terms;
attribution is shown on the map.

<!-- example -->

## The record behind the service

This endpoint is the WMS reference of a catalog record on the Czech INSPIRE
geoportal - [Základní mapa](https://geoportal.gov.cz/php/micka/record/basic/%7B98D8056D-D9D4-4D1B-AEF5-187E7BF0A1DB%7D?dlang=cze).
A record describes a dataset; the service URL inside it is what the map needs.

## More raster sources

Tile URLs and inline raster updates are covered in [Raster tiles](raster.md).
See [raster, MVT and media](../rendering.md#raster-tiles-and-wms) for the request
contract and [API contracts](../decisions.md) for the exact semantics.
