import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { unpackPackage } from '../src/package.js';
const manifest = JSON.parse(
  await readFile(new URL('../public/demos/manifest.json', import.meta.url), 'utf8'),
);
const expected = (name) => manifest.fixtures.find((f) => f.name === name).expected;
for (const name of ['console', 'files', 'messagebox', 'beep'])
  test(`executes original ${name}.exe from ZIP`, async () => {
    const bytes = new Uint8Array(
      await readFile(new URL(`../public/demos/${name}.zip`, import.meta.url)),
    );
    const pkg = await unpackPackage(bytes, name + '.zip');
    const events = [],
      requests = [];
    const r = new Runtime(iced, {
      ...pkg,
      exe: pkg.executables[0],
      emit: (e) => events.push(e),
      request: async (k, d) => {
        requests.push({ kind: k, ...d });
        return 1;
      },
    });
    const result = await r.run();
    assert.equal(result.exitCode, 0);
    assert.ok(result.compiledBlocks > 0);
    if (name === 'console') assert.equal(events.map((e) => e.text).join(''), expected(name).stdout);
    if (name === 'files') {
      assert.equal(result.outputs.length, 1);
      assert.match(result.outputs[0].path, /output.txt$/);
      assert.equal(
        new TextDecoder().decode(result.outputs[0].bytes),
        expected(name).createdFiles['output.txt'],
      );
      assert.equal(
        events.map((e) => e.text).join(''),
        new TextDecoder().decode(pkg.files.get('files/assets/message.txt')),
      );
    }
    if (name === 'messagebox') assert.equal(requests[0].kind, 'messagebox');
    if (name === 'beep') assert.equal(requests[0].frequency, 440);
  });

test('missing packaged asset follows the original EXE failure branch', async () => {
  const bytes = new Uint8Array(
    await readFile(new URL('../public/demos/files/files.exe', import.meta.url)),
  );
  const pkg = await unpackPackage(bytes, 'files.exe');
  const runtime = new Runtime(iced, { ...pkg, exe: 'files.exe' });
  assert.equal((await runtime.run()).exitCode, 1);
});
test('execution budgets and executable-memory writes fail explicitly', async () => {
  const bytes = new Uint8Array(
    await readFile(new URL('../public/demos/console.zip', import.meta.url)),
  );
  const pkg = await unpackPackage(bytes, 'console.zip');
  const runtime = new Runtime(iced, { ...pkg, exe: pkg.executables[0], maxBlocks: 1 });
  assert.throws(() => runtime.write32(runtime.pe.entryPoint, 0), /write violation/);
  await assert.rejects(runtime.run(), /budget exceeded/);
});
