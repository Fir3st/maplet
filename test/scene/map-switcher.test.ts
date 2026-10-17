import test from 'node:test';
import assert from 'node:assert/strict';

import { createMapSwitcher, isMapletError } from '../../src/index.ts';

const rejects = async (options: unknown, code: string): Promise<void> => {
  await assert.rejects(
    createMapSwitcher(options as never),
    (error: unknown) => isMapletError(error) && error.code === code,
  );
};

test('UI-10: the map switcher validates entries before requiring a browser host', async () => {
  await rejects({ container: 'host', maps: [] }, 'invalid-argument');
  await rejects(
    {
      container: 'host',
      maps: [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'B' },
      ],
    },
    'invalid-argument',
  );
  await rejects({ container: 'host', maps: [{ id: 'a', label: '  ' }] }, 'invalid-argument');
  await rejects(
    { container: 'host', maps: [{ id: 'a', label: 'A' }], initial: 'missing' },
    'invalid-argument',
  );
  await rejects({ container: undefined, maps: [{ id: 'a', label: 'A' }] }, 'invalid-argument');
  await rejects({ container: 'host', maps: [{ id: 'a', label: 'A' }] }, 'environment');
});
