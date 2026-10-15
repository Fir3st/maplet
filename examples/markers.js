import { openExample, action, ready, report } from './shared.js';

const map = await openExample();
const spots = [
  { id: 'depot', name: 'Freight depot', tint: '#2563eb', at: { x: -0.6, y: -0.42 } },
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

// One pin is draggable: its tip follows the pointer while the map stays put,
// and the drag survives icon edits because the override is rebuilt each time.
// Its permanent tooltip invites the drag without hover, so it sits clear of the
// container edges at the default view.
const craneHome = { x: -0.42, y: 0.4 };
const crane = map.addMarker({
  id: 'crane',
  position: craneHome,
  iconTint: '#7c3aed',
  draggable: true,
  // A permanent tooltip keeps the invitation visible without hover.
  tooltip: { content: 'Dock crane — drag me', permanent: true },
  popup: 'Drag this pin: the tip follows the pointer while the map stays put.',
});

const panel = document.createElement('div');
panel.className = 'panel';
const heading = document.createElement('h3');
heading.textContent = 'Draggable pin';
const rows = document.createElement('dl');
rows.className = 'rows';
const row = (label) => {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  rows.append(dt, dd);
  return dd;
};
const craneAt = row('Crane at');
const craneDrops = row('Drops');
panel.append(heading, rows);
const craneHint = document.createElement('p');
craneHint.textContent = 'Press the purple crane pin on the map and drag it — the pin follows the pointer while the map stays put.';
panel.append(craneHint);
document.querySelector('#example-extra').append(panel);
const craneText = () => {
  const at = crane.getPosition();
  craneAt.textContent = `${at.x.toFixed(2)}, ${at.y.toFixed(2)}`;
};
let drops = 0;
craneText();
crane.on('dragstart', () => report('Dragging the dock crane — the map will not pan until you drop it.'));
crane.on('dragend', () => {
  drops += 1;
  craneDrops.textContent = String(drops);
  craneText();
  report('Dock crane dropped — the map never panned and the tooltip followed the pin.');
});

let away = false, pinned = true, extra = null;
action('Move the market pin', () => {
  away = !away;
  market.setPosition(away ? { x: 0.62, y: -0.55 } : spots[1].at);
  report(`Market square moved ${away ? 'south-east' : 'back'}; its open popup follows it.`);
});
action('Reset the crane pin', () => {
  crane.setPosition(craneHome);
  craneText();
  report('Dock crane back at its home berth.');
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
await ready(map, { markers, depot, market, river, crane, craneHome });
