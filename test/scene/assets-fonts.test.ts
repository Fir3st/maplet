import test from 'node:test';
import assert from 'node:assert/strict';

import { isMapletError } from '../../src/api/errors.ts';
import { AssetRegistry } from '../../src/scene/assets.ts';

test('TEXT-05: font registration degrades explicitly without DOM and cleans up', () => {
  const registry = new AssetRegistry();
  const font = registry.addFont('brand', 'Brand', './brand.woff2');
  // Headless: never a silent success — the state is an observable error.
  assert.equal(font.state, 'error');
  assert.match(font.error ?? '', /not available/);
  assert.equal(registry.fontSignature('Brand'), 'error');
  assert.equal(registry.fontSignature('Unknown'), 'system');
  assert.equal(registry.listFonts().length, 1);

  registry.remove('brand');
  assert.equal(registry.listFonts().length, 0);
  // After removal the family is unknown again, so labels fall back next revision.
  assert.equal(registry.fontSignature('Brand'), 'system');
  registry.destroy();
});

test('TEXT-05: images and fonts share one asset id namespace', () => {
  const registry = new AssetRegistry();
  registry.addImage('shared', './image.png');
  assert.throws(
    () => registry.addFont('shared', 'Shared', './font.woff2'),
    (error: unknown) => isMapletError(error) && error.code === 'duplicate-id',
  );
  assert.throws(
    () => registry.addImage('shared', './image-2.png'),
    (error: unknown) => isMapletError(error) && error.code === 'duplicate-id',
  );
  assert.ok(registry.has('shared'));
  registry.destroy();
});

test('ASSET-01: the font signature is stable until a font version changes', () => {
  const registry = new AssetRegistry();
  const font = registry.addFont('f', 'Brand', './brand.woff2');
  // Headless error state: the signature reflects the state, not a version.
  assert.equal(registry.fontSignature('Brand'), 'error');
  font.state = 'ready';
  font.version = 3;
  assert.equal(registry.fontSignature('Brand'), 'ready@3');
  font.version = 4;
  assert.equal(registry.fontSignature('Brand'), 'ready@4');
  registry.destroy();
});
