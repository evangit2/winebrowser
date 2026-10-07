import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { readPEResource } from '../src/pe-resources.js';

async function setup(t, wide = false, replace = false, flags = 1) {
  const bytes = new Uint8Array(
    await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
  );
  const r = new Runtime(iced, { files: new Map([['console.exe', bytes]]), exe: 'console.exe' });
  t.after(() => r.windows.dispose());
  const callbacks = [];
  const parentProc = 0x12345678;
  r.callGuest = async (p, args) => {
    const entry = r.thunks.get(p);
    if (entry?.invoke) return (await entry.invoke(r, (i) => args[i] ?? 0)).result;
    assert.equal(p, parentProc);
    if (args[1] === 0x81) return 1;
    if (args[1] >= 0xc000) callbacks.push({ args: [...args], flags: r.read32(args[3] + 12) });
    return (await call('user32.dll!DefWindowProcA', ...args)).result;
  };
  const call = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] ?? 0);
  const cls = r.allocate(40),
    name = r.allocString('FindOwner');
  r.data.fill(0, cls, cls + 40);
  r.write32(cls + 4, parentProc);
  r.write32(cls + 16, r.pe.imageBase);
  r.write32(cls + 36, name);
  await call('user32.dll!RegisterClassA', cls);
  const owner = (
    await call(
      'user32.dll!CreateWindowExA',
      0,
      name,
      name,
      0x10c80000,
      0,
      0,
      300,
      150,
      0,
      0,
      r.pe.imageBase,
      0,
    )
  ).result;
  const p = r.allocate(40),
    find = r.allocate(20),
    replacement = r.allocate(20);
  r.data.fill(0, p, p + 40);
  r.data.fill(0xaa, find, find + 20);
  r.data.fill(0xbb, replacement, replacement + 20);
  r.write32(p, 40);
  r.write32(p + 4, owner);
  r.write32(p + 12, flags);
  r.write32(p + 16, find);
  r.write32(p + 20, replacement);
  r.view.setUint16(p + 24, 4, true);
  r.view.setUint16(p + 26, 4, true);
  if (wide) {
    r.view.setUint16(find, 0, true);
    r.view.setUint16(replacement, 0, true);
  } else r.data[find] = r.data[replacement] = 0;
  const open = () =>
    call(`comdlg32.dll!${replace ? 'ReplaceText' : 'FindText'}${wide ? 'W' : 'A'}`, p);
  const child = (id, control) =>
    [...r.windows.windows.values()].find((w) => w.parentId === id && w.controlId === control);
  return { r, p, find, replacement, owner, callbacks, call, open, child };
}

test('A/W modeless replacement bounds output buffers, rebuilds flags and terminates exactly once', async (t) => {
  for (const wide of [false, true]) {
    const { r, p, find, replacement, owner, callbacks, open, child } = await setup(
      t,
      wide,
      true,
      0x80 | 0x20,
    );
    const id = (await open()).result;
    assert.ok(id);
    assert.equal(r.windows.isEnabled(owner), true);
    assert.equal(child(id, 1).enabled, false);
    const text = wide ? 'Ω€ABCD' : 'caféXYZ';
    await r.windows.send(child(id, 1152).id, 0xc, 0, r.allocString(text, wide));
    await r.windows.send(child(id, 1153).id, 0xc, 0, r.allocString(text, wide));
    child(id, 1040).checkState = child(id, 1041).checkState = 1;
    assert.equal(child(id, 1).enabled, true);
    await r.windows.send(id, 0x111, 1024);
    assert.equal(callbacks.length, 1);
    assert.equal(callbacks[0].args[3], p);
    assert.equal(callbacks[0].flags, 0x80 | 1 | 2 | 4 | 16);
    assert.equal(wide ? r.wideString(find) : r.string(find), text.slice(0, 3));
    assert.equal(wide ? r.wideString(replacement) : r.string(replacement), text.slice(0, 3));
    assert.ok(r.data.slice(find + (wide ? 8 : 4), find + 20).every((b) => b === 0xaa));
    assert.ok(
      r.data.slice(replacement + (wide ? 8 : 4), replacement + 20).every((b) => b === 0xbb),
    );
    await r.windows.send(id, 0x111, 1025);
    assert.equal(callbacks[1].flags, 0x80 | 1 | 2 | 4 | 32);
    await r.windows.send(id, 0x10);
    assert.equal(callbacks[2].flags, 0x80 | 1 | 2 | 4 | 64);
    assert.equal(r.windows.windows.has(id), false);
    assert.equal(r.windows.isEnabled(owner), true);
    await r.windows.send(id, 0x10);
    assert.equal(callbacks.length, 3);
  }
});

test('Find flags hide/disable requested controls and clear stale downward/action bits', async (t) => {
  const { r, p, callbacks, child, open } = await setup(
    t,
    false,
    false,
    0x10000 | 0x800 | 0x400 | 32,
  );
  const id = (await open()).result;
  assert.ok(id);
  assert.equal(child(id, 1040).visible, false);
  assert.equal(child(id, 1041).enabled, false);
  assert.equal(child(id, 1056).enabled, false);
  assert.equal(child(id, 1057).checkState, 0);
  assert.equal(child(id, 1038).visible, false);
  await r.windows.send(child(id, 1152).id, 0xc, 0, r.allocString('up'));
  await r.windows.send(id, 0x111, 1);
  assert.equal(callbacks[0].flags & 0x7f, 8);
  assert.equal(r.read32(p + 12) & 0x7f, 8);
  await r.windows.destroy(id); // external destruction does not synthesize FR_DIALOGTERM
  assert.equal(callbacks.length, 1);
});

test('common-dialog failures reject bad layouts, owners, buffers, hooks and invalid templates', async (t) => {
  const { r, p, owner, find, call, open } = await setup(t);
  assert.equal((await call('comdlg32.dll!FindTextA', 0)).result, 0);
  assert.equal(r.commonDialogError, 2);
  const failures = [
    [() => r.write32(p, 39), 1],
    [
      () => {
        r.write32(p, 40);
        r.write32(p + 4, 0);
      },
      0xffff,
    ],
    [
      () => {
        r.write32(p + 4, owner);
        r.view.setUint16(p + 24, 0, true);
      },
      0x4001,
    ],
    [
      () => {
        r.view.setUint16(p + 24, 4, true);
        r.data.fill(65, find, find + 4);
      },
      0x4001,
    ],
    [
      () => {
        r.data[find] = 0;
        r.write32(p + 12, 0x100);
      },
      11,
    ],
    [() => r.write32(p + 12, 0x200), 4],
    [
      () => {
        r.write32(p + 8, r.pe.imageBase);
      },
      3,
    ],
    [() => r.write32(p + 36, 404), 6],
    [() => r.write32(p + 12, 0x2000), 7],
    [() => r.write32(p + 12, 0x80000000), 2],
  ];
  for (const [change, error] of failures) {
    change();
    assert.equal((await open()).result, 0);
    assert.equal(r.commonDialogError, error);
    assert.equal(r.windows.windows.size, 1);
  }
  r.write32(p + 12, 1);
  assert.ok((await open()).result);
  assert.equal(r.commonDialogError, 0);
});

test('allocated HGLOBAL templates support A/W Find without taking caller ownership', async (t) => {
  const library = new Uint8Array(
    await readFile(new URL('./fixtures/find-dialogs/find-resources.dll', import.meta.url)),
  );
  const template = readPEResource(library, 5, 201);
  assert.ok(template);
  for (const wide of [false, true]) {
    const { r, p, owner, call, open, child } = await setup(t, wide, false, 0x2000 | 1 | 0x200);
    const memory = (await call('kernel32.dll!GlobalAlloc', 0x42, template.length)).result;
    const locked = (await call('kernel32.dll!GlobalLock', memory)).result;
    assert.ok(locked);
    r.data.set(template, locked);
    r.write32(p + 8, memory);
    await call('kernel32.dll!GlobalUnlock', memory);
    const id = (await open()).result;
    assert.ok(id);
    assert.equal(r.windows.windows.get(id).title, 'Find in native DLL');
    assert.equal((await call('user32.dll!IsWindowUnicode', child(id, 1152).id)).result, +wide);
    await call('user32.dll!SetDlgItemTextW', id, 1152, r.allocString('Ω€', true));
    const output = r.allocate(16);
    assert.equal((await call('user32.dll!GetDlgItemTextW', id, 1152, output, 8)).result, 2);
    assert.equal(r.wideString(output), 'Ω€');
    await r.windows.destroy(id);
    assert.equal((await call('kernel32.dll!GlobalSize', memory)).result >= template.length, true);
    assert.equal(r.windows.isEnabled(owner), true);
    // The ordinary W dialog APIs must retain Unicode for frame and controls too.
    const ordinary = (
      await call(
        'user32.dll!CreateDialogIndirectParamW',
        r.pe.imageBase,
        locked,
        owner,
        0x12345678,
        0,
      )
    ).result;
    assert.ok(ordinary);
    assert.equal((await call('user32.dll!IsWindowUnicode', ordinary)).result, 1);
    assert.equal((await call('user32.dll!IsWindowUnicode', child(ordinary, 1152).id)).result, 1);
    await call('user32.dll!SetDlgItemTextW', ordinary, 1152, r.allocString('Ω€', true));
    await call('user32.dll!GetDlgItemTextW', ordinary, 1152, output, 8);
    assert.equal(r.wideString(output), 'Ω€');
    await r.windows.destroy(ordinary);
    assert.equal((await call('kernel32.dll!GlobalFree', memory)).result, 0);
    r.write32(p + 12, 0x2000);
    assert.equal((await open()).result, 0);
    assert.equal(r.commonDialogError, 7);
  }
});

test('DLL resource size/load use HRSRC, preserve FreeResource data and decode Unicode names', async (t) => {
  const { r, call } = await setup(t);
  const library = new Uint8Array(
    await readFile(new URL('./fixtures/find-dialogs/find-resources.dll', import.meta.url)),
  );
  const module = 0x20000000;
  r.files.set('find-resources.dll', library);
  r.graph.modules.set('find-resources.dll', {
    base: module,
    path: 'find-resources.dll',
    bytes: library,
  });
  for (const [name, wide] of [
    [201, false],
    ['GUIΩ', true],
  ]) {
    const parameter = typeof name === 'number' ? name : r.allocString(name, wide);
    const resource = await call(
      `kernel32.dll!FindResource${wide ? 'W' : 'A'}`,
      module,
      parameter,
      5,
    );
    assert.equal(resource.argc, 3);
    assert.ok(resource.result);
    const payload = readPEResource(library, 5, name);
    assert.deepEqual(await call('kernel32.dll!SizeofResource', module, resource.result), {
      result: payload.length,
      argc: 2,
    });
    const loaded = await call('kernel32.dll!LoadResource', module, resource.result);
    assert.deepEqual(loaded, { result: resource.result, argc: 2 });
    const address = (await call('kernel32.dll!LockResource', loaded.result)).result;
    assert.deepEqual(r.data.slice(address, address + payload.length), payload);
    assert.deepEqual(await call('kernel32.dll!FreeResource', loaded.result), {
      result: 0,
      argc: 1,
    });
    assert.equal((await call('kernel32.dll!LockResource', loaded.result)).result, address);
    assert.deepEqual(r.data.slice(address, address + payload.length), payload);
  }
  const ex = await call('kernel32.dll!FindResourceExA', module, 5, 201, 0);
  assert.ok(ex.result);
  assert.equal(ex.argc, 4);
  for (const api of ['SizeofResource', 'LoadResource']) {
    assert.deepEqual(await call(`kernel32.dll!${api}`, module, 0x1234), { result: 0, argc: 2 });
    assert.equal(r.lastError, 1812);
  }
});
