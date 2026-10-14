# Background

Maplet takes inspiration from Leaflet's approachable map and layer workflow, but
uses its own GPU rendering pipeline and data model. It is not a Leaflet plugin or
a compatible replacement.

## Changing map objects

The project focuses on individually editable objects: points can move, change
appearance or visibility, and retain their identity. Shared sources, transactions,
relations and bindings keep connected geometry consistent during those changes.

Points, sprites and labels are batched rather than represented by one HTML marker
per feature. Heterogeneous layers organize those objects into a tree. This is a
design choice, not proof that GPU rendering is faster for every map.

Leaflet's SVG and Canvas paths are mutable too; Canvas is not inherently static.
Leaflet.PixiOverlay illustrates a different approach, combining a Leaflet map
with PixiJS graphics. Maplet brings map coordinates, identity and rendering into
one library instead of requiring that overlay integration.

## Performance evidence

Development measurements cover a 500,000-point fixture and mixed vector, sprite
and label scenes. Results, evaluator inputs and limitations are kept in
[the benchmark records](benchmarks/README.md), not presented as universal device
or workload guarantees. PixiJS has not been benchmarked.

## Coordinate heritage

Some calculations derive from Leaflet: spherical Web Mercator, its latitude
limit, world scale and longitude wrapping. Tests use Leaflet 1.9.4 as an oracle.
Maplet's EPSG:4326 mapping and mean Earth radius deliberately differ; see
[coordinate contracts](decisions.md#units-and-coordinates).

Maplet's original material is Apache-2.0. Leaflet-derived material retains
BSD-2-Clause terms, and development fixtures have their own licenses. See
[LICENSE](../LICENSE) and [NOTICE](../NOTICE).
