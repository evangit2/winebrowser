import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const setup = () =>
  new Runtime(iced, { exe: 'console.exe', files: new Map([['console.exe', exe]]) });
const api = (r, name, args) => r.apiProvider.get('kernel32.dll!' + name)(r, (i) => args[i]);
const nt = (r, name, args) => ntServices[name].call(r, (i) => args[i]);
test('native and host handle flag services share state and protected closes preserve a live event', () => {
  const r = setup(),
    event = api(r, 'CreateEventW', [0, 0, 0, 0]).result;
  const buffer = r.allocate(8),
    returned = r.allocate(4);
  r.data.fill(0xcc, buffer, buffer + 8);
  assert.equal(api(r, 'SetHandleInformation', [event, 3, 3]).result, 1);
  assert.equal(nt(r, 'NtQueryObject', [event, 4, buffer, 8, returned]), 0);
  assert.equal(r.read32(returned), 2);
  assert.deepEqual(
    [...r.data.subarray(buffer, buffer + 8)],
    [1, 1, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc],
  );
  assert.equal(nt(r, 'NtClose', [event]), 0xc0000235);
  assert.equal(api(r, 'CloseHandle', [event]).result, 0);
  assert.equal(r.lastError, 6);
  assert.equal(api(r, 'SetEvent', [event]).result, 1);
  r.data[buffer] = 0;
  r.data[buffer + 1] = 0;
  assert.equal(nt(r, 'NtSetInformationObject', [event, 4, buffer, 2]), 0);
  assert.equal(api(r, 'GetHandleInformation', [event, buffer]).result, 1);
  assert.equal(r.read32(buffer), 0);
  assert.equal(api(r, 'CloseHandle', [event]).result, 1);
  assert.equal(nt(r, 'NtClose', [event]), 0xc0000008);
  assert.equal(nt(r, 'NtQueryObject', [event, 4, buffer, 2, 0]), 0xc0000008);
});
test('handle queries reject unsupported classes, short/invalid buffers and closed output handles', () => {
  const r = setup(),
    buffer = r.allocate(4),
    returned = r.allocate(4);
  r.write32(buffer, 0xaabbccdd);
  assert.equal(nt(r, 'NtQueryObject', [1, 4, buffer, 1, returned]), 0xc0000206);
  assert.equal(nt(r, 'NtQueryObject', [1, 4, 0, 2, returned]), 0xc0000005);
  assert.equal(nt(r, 'NtQueryObject', [1, 3, buffer, 4, returned]), 0xc0000003);
  assert.equal(r.read32(buffer), 0xaabbccdd);
  r.data[buffer] = 1;
  r.data[buffer + 1] = 1;
  assert.equal(nt(r, 'NtSetInformationObject', [1, 4, buffer, 2]), 0);
  assert.equal(nt(r, 'NtClose', [1]), 0xc0000235);
  assert.equal(api(r, 'SetHandleInformation', [1, 2, 0]).result, 1);
  assert.equal(api(r, 'GetHandleInformation', [1, buffer]).result, 1);
  assert.equal(r.read32(buffer), 1);
  assert.equal(nt(r, 'NtClose', [1]), 0);
  assert.equal(nt(r, 'NtQueryObject', [1, 4, buffer, 2, 0]), 0xc0000008);
  assert.equal(api(r, 'GetHandleInformation', [0, buffer]).result, 0);
});
