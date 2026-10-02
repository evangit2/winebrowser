import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { inspectPublicationAsset } from '../scripts/lib/publication-assets.mjs';

test('publication checks reject private bytes under renamed files and nested ZIP entries', () => {
  const bytes = new TextEncoder().encode('Synthetic private fixture bytes, not game content');
  const deny = new Map([[createHash('sha256').update(bytes).digest('hex'), 'private-test.bin']]);
  assert.throws(
    () => inspectPublicationAsset('innocent.dat', bytes, deny),
    /matches private-test.bin/,
  );
  const zip = zipSync({ 'outer.zip': zipSync({ 'renamed.bin': bytes }) });
  assert.throws(
    () => inspectPublicationAsset('example.zip', zip, deny),
    /matches private-test.bin/,
  );
  assert.doesNotThrow(() => inspectPublicationAsset('example.zip', zip, new Map()));
});

test('publication rejects game and proprietary DLL/music filenames inside archives', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  for (const name of ['Hamsterball.exe', 'BASS.DLL', 'music.mo3', 'folder\\bass.dll']) {
    assert.throws(
      () => inspectPublicationAsset('assets.zip', zipSync({ [name]: bytes })),
      /cannot be published/,
    );
  }
  assert.doesNotThrow(() => inspectPublicationAsset('third_party/Hamsterball-LICENSE.txt', bytes));
});
