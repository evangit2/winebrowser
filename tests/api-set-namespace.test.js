import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { PEB_API_SET_MAP } from '../src/api-set-namespace.js';
import { WINE_API_SET_SCHEMA } from '../src/wine-api-set-schema.js';

test('unchanged Wine NTDLL independently searches every guest PEB API-set entry', async () => {
  const bytes = async (path) => new Uint8Array(await readFile(path));
  const r = new Runtime(iced, {
    exe: 'console.exe',
    files: new Map([['console.exe', await bytes('public/demos/console/console.exe')]]),
    builtinFiles: new Map([['ntdll.dll', await bytes('public/runtime/wine-base/ntdll.dll')]]),
  });
  try {
    assert.equal(r.read32(PEB_API_SET_MAP), r.apiSetMap);
    await r.loadLibrary('ntdll.dll');
    const module = r.graph.findLoaded('ntdll.dll');
    const query = await r.resolveExport(module, 'ApiSetQueryApiSetPresenceEx');
    const presence = await r.resolveExport(module, 'ApiSetQueryApiSetPresence');
    const us = r.allocate(8),
      output = r.allocate(2),
      text = r.allocate(512);
    const queryName = (name, fn = query) => {
      r.data.fill(0, text, text + 512);
      for (let i = 0; i < name.length; i++)
        r.guestMemory.write(text + i * 2, name.charCodeAt(i), 2);
      r.guestMemory.write(us, name.length * 2, 2);
      r.guestMemory.write(us + 2, name.length * 2 + 2, 2);
      r.write32(us + 4, text);
      r.data.fill(0xfe, output, output + 2);
      return r.callGuest(fn, fn === query ? [us, output, output + 1] : [us, output + 1]);
    };
    for (const [name, target] of Object.entries(WINE_API_SET_SCHEMA)) {
      assert.equal(await queryName(name.toUpperCase()), 0, name);
      assert.deepEqual([...r.data.slice(output, output + 2)], [1, target ? 1 : 0], name);
    }
    assert.equal(await queryName('api-ms-win-core-file-l1-1-99', presence), 0);
    assert.equal(r.data[output + 1], 1, 'ordinary presence uses revision-independent matching');
    assert.equal(await queryName('api-ms-win-core-file-l1-1-99'), 0);
    assert.deepEqual(
      [...r.data.slice(output, output + 2)],
      [0, 0],
      'Ex requires the full schema name',
    );
    assert.equal(await queryName('api-ms-win-core-made-up-l1-1-0'), 0);
    assert.deepEqual([...r.data.slice(output, output + 2)], [0, 0]);
    assert.equal(await queryName('api-ms-win-core-file-l1-1-0.dll'), 0xc000000d);
    assert.deepEqual([...r.data.slice(output, output + 2)], [0xfe, 0xfe]);
  } finally {
    r.windows.dispose();
    r.cpu.dispose();
  }
});
