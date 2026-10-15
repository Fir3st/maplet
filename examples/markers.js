import { openExample, action, ready, report } from './shared.js';

const map = await openExample();
const spots = [
  { id: 'depot', name: 'Freight depot', tint: '#2563eb', at: { x: -0.95, y: -0.42 } },
  { id: 'market', name: 'Market square', tint: '#16724c', at: { x: 0.1, y: 0.35 } },
  { id: 'river', name: 'River walk', tint: '#b45309', at: { x: 0.95, y: -0.3 } },
];
const markers = map.addMarkers(spots.map(spot => ({
  id: spot.id,
  position: spot.at,
  iconTint: spot.tint,
  tooltip: spot.name,
  popup: { content: `${spot.name} — click a pin and its popup follows the map.` },
})));
const [depot, market, river] = markers;
// A permanent tooltip stays visible without hover.
depot.setTooltip({ content: 'Freight depot · 12 platforms', permanent: true });

let away = false, pinned = true, extra = null;
action('Move the market pin', () => {
  away = !away;
  market.setPosition(away ? { x: 0.62, y: -0.55 } : spots[1].at);
  report(`Market square moved ${away ? 'south-east' : 'back'}; its open popup follows it.`);
});
action('Open the river popup', () => {
  river.openPopup();
  report('Auto-pan keeps the popup inside the view; a background click closes it.');
});
action('Toggle permanent tooltip', () => {
  pinned = !pinned;
  depot.setTooltip(pinned ? { content: 'Freight depot · 12 platforms', permanent: true } : null);
  report(pinned ? 'The depot tooltip is permanent again.' : 'The depot tooltip is unbound.');
});
action('Add / remove a pin', () => {
  if (extra) {
    extra.remove();
    extra = null;
    report('The extra pin and its overlays are gone; the other pins remain.');
    return;
  }
  extra = map.addMarker({
    id: 'extra',
    position: { x: 0.45, y: 0.62 },
    tooltip: 'Extra pin',
    popup: 'I was added through the same API.',
  });
  report('Extra pin added — hover it for a tooltip, click it for the popup.');
});
await ready(map, { markers, depot, market, river });
