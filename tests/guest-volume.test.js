import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
import { syncObjects } from '../src/sync-objects.js';
import { VOLUME_BYTES, CLUSTER_BYTES, volumeUsage } from '../src/guest-volume.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.syncObjects?.dispose();
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] >>> 0);
  const nt = (name, ...args) => ntServices[name].call(r, (i) => args[i] >>> 0);
  return { r, api, nt };
}
function attributes(r, name) {
  const p = r.allocate(24),
    u = r.allocate(8),
    text = r.allocString(name, true);
  r.view.setUint16(u, name.length * 2, true);
  r.view.setUint16(u + 2, (name.length + 1) * 2, true);
  r.write32(u + 4, text);
  [24, 0, u, 0x40, 0, 0].forEach((v, i) => r.write32(p + i * 4, v));
  return p;
}

test('disk APIs use SDK argument counts, separate optional outputs, A/W paths and actual content usage', (t) => {
  const { r, api } = setup(t),
    output = r.allocate(48);
  for (const wide of [false, true]) {
    const suffix = wide ? 'W' : 'A';
    for (const text of [
      null,
      'C:\\',
      'C:\\winebrowser\\',
      '.',
      'C:\\winebrowser\\missing',
      'D:\\',
      '\\\\server\\share',
      'console.exe',
      '',
    ]) {
      const path = text === null ? 0 : r.allocString(text, wide);
      r.data.fill(0xcc, output, output + 48);
      const accepted = [null, 'C:\\', 'C:\\winebrowser\\', '.'].includes(text);
      const result = api(
        'kernel32.dll!GetDiskFreeSpaceEx' + suffix,
        path,
        output,
        output + 8,
        output + 16,
      );
      assert.equal(result.argc, 4);
      assert.equal(result.result, +accepted, text);
      if (accepted) {
        assert.equal(r.view.getBigUint64(output + 8, true), BigInt(VOLUME_BYTES));
        assert.equal(
          r.view.getBigUint64(output, true),
          BigInt(Math.floor((VOLUME_BYTES - exe.length) / 4096) * 4096),
        );
        assert.equal(r.view.getBigUint64(output + 16, true), r.view.getBigUint64(output, true));
        assert.ok(r.data.subarray(output + 24, output + 48).every((v) => v === 0xcc));
        assert.equal(
          api(
            'kernel32.dll!GetDiskFreeSpace' + suffix,
            path,
            output,
            output + 4,
            output + 8,
            output + 12,
          ).argc,
          5,
        );
        assert.deepEqual(
          [0, 4, 8, 12].map((n) => r.read32(output + n)),
          [8, 512, Math.floor((VOLUME_BYTES - exe.length) / 4096), 32768],
        );
        assert.equal(
          api('kernel32.dll!GetDiskFreeSpaceEx' + suffix, path, 0, output + 8, 0).result,
          1,
        );
      } else {
        assert.equal(
          r.lastError,
          text === 'C:\\winebrowser\\missing' ? 2 : text === 'console.exe' ? 267 : 3,
        );
        assert.ok(r.data.subarray(output, output + 48).every((v) => v === 0xcc));
      }
    }
  }
  // An invalid later output cannot partially publish earlier values.
  r.data.fill(0xcc, output, output + 48);
  assert.throws(() => api('kernel32.dll!GetDiskFreeSpaceExA', 0, output, 1, 0));
  assert.ok(r.data.subarray(output, output + 48).every((v) => v === 0xcc));
});

test('logical drive multistring capacities count characters and preserve short buffers and guards', (t) => {
  const { r, api } = setup(t),
    output = r.allocate(32);
  for (const wide of [false, true]) {
    const suffix = wide ? 'W' : 'A',
      unit = wide ? 2 : 1;
    for (const capacity of [0, 1, 4, 5, 8]) {
      r.data.fill(0xcc, output, output + 32);
      r.lastError = 77;
      const result = api('kernel32.dll!GetLogicalDriveStrings' + suffix, capacity, output);
      assert.equal(result.argc, 2);
      assert.equal(result.result, capacity < 5 ? 5 : 4);
      assert.equal(r.lastError, 77);
      if (capacity < 5) assert.ok(r.data.subarray(output, output + 32).every((v) => v === 0xcc));
      else {
        assert.deepEqual(
          Array.from({ length: 5 }, (_, i) =>
            wide ? r.view.getUint16(output + i * 2, true) : r.data[output + i],
          ),
          [67, 58, 92, 0, 0],
        );
        assert.ok(r.data.subarray(output + 5 * unit, output + 32).every((v) => v === 0xcc));
      }
    }
    assert.equal(api('kernel32.dll!GetLogicalDriveStrings' + suffix, 0, 0).result, 5);
  }
});

test('native NT volume root handles grant metadata only; size layouts validate IOSB, lengths and regions', (t) => {
  const { r, nt } = setup(t),
    out = r.allocate(4),
    status = r.allocate(8),
    info = r.allocate(48);
  const attr = attributes(r, '\\??\\C:\\');
  assert.equal(nt('NtOpenFile', out, 0x100000, attr, status, 0, 0x21), 0);
  const handle = r.read32(out);
  assert.equal(r.handles.get(handle).kind, 'volume-metadata');
  assert.equal(nt('NtOpenFile', out, 0x100020, attr, status, 0, 0x21), 0xc0000022);
  assert.equal(nt('NtReadFile', handle, 0, 0, 0, status, info, 1, 0, 0), 0xc0000008);
  for (const [kind, size] of [
    [3, 24],
    [7, 32],
  ]) {
    r.data.fill(0xcc, info, info + 48);
    assert.equal(
      nt('NtQueryVolumeInformationFile', handle, status, info, size - 1, kind),
      0xc0000023,
    );
    assert.equal(r.read32(status + 4), 0);
    assert.ok(r.data.subarray(info, info + 48).every((v) => v === 0xcc));
    assert.equal(nt('NtQueryVolumeInformationFile', handle, status, 0, size, kind), 0xc0000005);
    assert.equal(nt('NtQueryVolumeInformationFile', handle, 0, info, size, kind), 0xc0000005);
    assert.equal(nt('NtQueryVolumeInformationFile', 1, status, info, size, kind), 0xc000000d);
    assert.equal(nt('NtQueryVolumeInformationFile', handle, status, info, size, kind), 0);
    assert.equal(r.read32(status + 4), size);
    assert.equal(r.view.getBigInt64(info, true), 32768n);
    assert.equal(r.view.getBigInt64(info + 8, true), BigInt(volumeUsage(r).availableUnits));
    if (kind === 7)
      assert.equal(r.view.getBigInt64(info + 16, true), r.view.getBigInt64(info + 8, true));
    assert.equal(r.read32(info + size - 8), 8);
    assert.equal(r.read32(info + size - 4), 512);
    assert.ok(r.data.subarray(info + size, info + 48).every((v) => v === 0xcc));
  }
  assert.equal(nt('NtClose', handle), 0);
  assert.equal(nt('NtQueryVolumeInformationFile', handle, status, info, 24, 3), 0xc0000008);
  assert.equal(nt('NtClose', handle), 0xc0000008);
  assert.equal(
    nt('NtOpenFile', out, 0x100000, attributes(r, '\\??\\D:\\'), status, 0, 0x21),
    0xc000003a,
  );
});

test('NT directory enumeration discovers C drive and real named objects with restart, pagination and access control', (t) => {
  const { r, nt } = setup(t),
    out = r.allocate(4),
    buffer = r.allocate(512),
    context = r.allocate(4),
    returned = r.allocate(4);
  assert.equal(nt('NtOpenDirectoryObject', out, 1, attributes(r, '\\DosDevices')), 0);
  const dos = r.read32(out);
  r.write32(context, 0);
  r.data.fill(0xcc, buffer, buffer + 512);
  assert.equal(nt('NtQueryDirectoryObject', dos, buffer, 16, 1, 0, context, returned), 0xc0000023);
  assert.equal(r.read32(context), 0);
  const required = r.read32(returned);
  assert.ok(required > 32);
  assert.ok(r.data.subarray(buffer, buffer + 16).every((v) => v === 0));
  assert.ok(r.data.subarray(buffer + 16, buffer + 512).every((v) => v === 0xcc));
  assert.equal(nt('NtQueryDirectoryObject', dos, buffer, 16, 0, 1, context, returned), 0x105);
  assert.equal(r.read32(context), 0);
  assert.equal(r.read32(returned), 16);
  assert.equal(nt('NtQueryDirectoryObject', dos, buffer, required, 1, 0, context, returned), 0);
  assert.equal(r.wideString(r.read32(buffer + 4)), 'C:');
  assert.equal(r.wideString(r.read32(buffer + 12)), 'SymbolicLink');
  assert.ok(r.data.subarray(buffer + 16, buffer + 32).every((v) => v === 0));
  assert.ok(r.data.subarray(buffer + required, buffer + 512).every((v) => v === 0xcc));
  assert.equal(r.read32(context), 1);
  assert.equal(nt('NtQueryDirectoryObject', dos, buffer, 512, 1, 0, context, returned), 0x8000001a);
  assert.equal(nt('NtQueryDirectoryObject', dos, buffer, 512, 1, 1, context, returned), 0);
  assert.equal(nt('NtQueryDirectoryObject', dos, 0, 512, 1, 1, context, returned), 0xc0000005);
  assert.equal(r.read32(context), 1);
  assert.equal(nt('NtOpenDirectoryObject', out, 2, attributes(r, '\\DosDevices')), 0);
  assert.equal(
    nt('NtQueryDirectoryObject', r.read32(out), buffer, 512, 1, 1, context, returned),
    0xc0000022,
  );
  const objects = syncObjects(r);
  const event = objects.event({ name: '\\BaseNamedObjects\\a' }).handle;
  const semaphore = objects.semaphore({ name: '\\BaseNamedObjects\\b' }).handle;
  const base = objects.directory('\\BaseNamedObjects', 1, false).handle;
  r.write32(context, 0);
  assert.equal(nt('NtQueryDirectoryObject', base, buffer, 56, 0, 0, context, returned), 0x105);
  assert.equal(r.wideString(r.read32(buffer + 4)), 'a');
  assert.equal(r.wideString(r.read32(buffer + 12)), 'Event');
  assert.equal(nt('NtQueryDirectoryObject', base, buffer, 512, 0, 0, context, returned), 0);
  assert.equal(r.wideString(r.read32(buffer + 4)), 'b');
  assert.equal(r.wideString(r.read32(buffer + 12)), 'Semaphore');
  assert.equal(objects.close(event), 0);
  assert.equal(objects.close(semaphore), 0);
  assert.equal(
    nt('NtQueryDirectoryObject', base, buffer, 512, 0, 1, context, returned),
    0x8000001a,
  );
  assert.equal(nt('NtClose', dos), 0);
  assert.equal(nt('NtQueryDirectoryObject', dos, buffer, 512, 1, 1, context, returned), 0xc0000008);
});

test('Win32 and NT writes and resizes enforce the queried quota and preserve files on failure', (t) => {
  const { r, api, nt } = setup(t),
    source = r.allocate(8192),
    out = r.allocate(8),
    status = r.allocate(8),
    size = r.allocate(8);
  r.data.fill(0x5a, source, source + 8192);
  const name = r.allocString('quota.bin');
  const handle = api('kernel32.dll!CreateFileA', name, 0xc0000000, 7, 0, 2, 0, 0).result;
  r.files.set('imported.bin', new Uint8Array(VOLUME_BYTES - volumeUsage(r).used - 4096));
  const free = volumeUsage(r).free;
  assert.equal(free, CLUSTER_BYTES);
  assert.equal(api('kernel32.dll!WriteFile', handle, source, 8192, out, 0).result, 0);
  assert.equal(r.lastError, 112);
  assert.equal(r.read32(out), 0);
  assert.equal(r.files.get('quota.bin').length, 0);
  assert.equal(api('kernel32.dll!WriteFile', handle, source, 4096, out, 0).result, 1);
  assert.equal(volumeUsage(r).free, 0);
  r.handles.get(handle).position = 8192;
  assert.equal(api('kernel32.dll!SetEndOfFile', handle).result, 0);
  assert.equal(r.lastError, 112);
  r.view.setBigInt64(size, 8192n, true);
  assert.equal(nt('NtSetInformationFile', handle, status, size, 8, 20), 0xc000007f);
  assert.equal(nt('NtWriteFile', handle, 0, 0, 0, status, source, 1, 0, 0), 0xc000007f);
  assert.equal(r.files.get('quota.bin').length, 4096);
  r.handles.get(handle).position = 0;
  assert.equal(
    api('kernel32.dll!WriteFile', handle, source, 4096, out, 0).result,
    1,
    'overwrite full volume',
  );
  assert.equal(nt('NtWriteFile', handle, 0, 0, 0, status, source, 4096, 0, 0), 0xc000007f);
  r.handles.get(handle).position = 0;
  r.view.setBigInt64(size, 0n, true);
  assert.equal(nt('NtSetInformationFile', handle, status, size, 8, 20), 0);
  assert.equal(volumeUsage(r).free, free);
  assert.equal(api('kernel32.dll!SetEndOfFile', handle).result, 1);
  assert.equal(api('kernel32.dll!CloseHandle', handle).result, 1);
  assert.equal(api('kernel32.dll!DeleteFileA', name).result, 1);
  assert.equal(volumeUsage(r).free, free);
});

test('CRT diskfree uses the 16-byte SDK structure and stdio fails with ENOSPC without changing position or content', async (t) => {
  const { r, api } = setup(t),
    info = r.allocate(24),
    data = r.allocate(4096);
  r.data.fill(0xcc, info, info + 24);
  assert.equal((await api('msvcrt.dll!_getdiskfree', 3, info)).result, 0);
  assert.deepEqual(
    [0, 4, 8, 12].map((i) => r.read32(info + i)),
    [32768, volumeUsage(r).availableUnits, 8, 512],
  );
  assert.ok(r.data.subarray(info + 16, info + 24).every((v) => v === 0xcc));
  r.data.fill(0xcc, info, info + 24);
  assert.equal((await api('msvcrt.dll!_getdiskfree', 4, info)).result, 15);
  assert.ok(r.data.subarray(info, info + 24).every((v) => v === 0xcc));
  const stream = (await api('msvcrt.dll!fopen', r.allocString('stdio.bin'), r.allocString('wb')))
    .result;
  assert.ok(stream);
  r.files.set('imported.bin', new Uint8Array(VOLUME_BYTES - volumeUsage(r).used));
  assert.equal((await api('msvcrt.dll!fwrite', data, 1, 4096, stream)).result, 0);
  assert.equal(r.read32((await api('msvcrt.dll!_errno')).result), 28);
  assert.notEqual((await api('msvcrt.dll!ferror', stream)).result, 0);
  assert.equal((await api('msvcrt.dll!ftell', stream)).result, 0);
  assert.equal(r.files.get('stdio.bin').length, 0);
  // Imported content exceeding the writable budget can still be shrunk.
  r.files.set('extra.bin', new Uint8Array(1));
  const handle = api(
    'kernel32.dll!CreateFileA',
    r.allocString('imported.bin'),
    0x40000000,
    7,
    0,
    3,
    0,
    0,
  ).result;
  r.handles.get(handle).position = 16;
  assert.equal(api('kernel32.dll!SetEndOfFile', handle).result, 1);
  assert.equal(r.files.get('imported.bin').length, 16);
});
