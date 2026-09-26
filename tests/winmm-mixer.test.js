import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { mixerApis, applyMixerGain } from '../src/winmm-mixer.js';
import { mixerWave, probeWinmm } from '../scripts/lib/winmm-probe.js';

const executable = new Uint8Array(await readFile('tests/fixtures/winmm/mixer.exe'));
const setup = () =>
  new Runtime(iced, { files: new Map([['mixer.exe', executable]]), exe: 'mixer.exe' });
const call = (r, name, args = []) => mixerApis['winmm.dll!' + name](r, (i) => args[i]);
test('native MinGW WinMM mixer ABI controls the actual PCM driver samples', async () => {
  const result = await probeWinmm(iced, {
    files: new Map([
      ['mixer.exe', executable],
      ['tone.wav', mixerWave()],
    ]),
  });
  assert.equal(result.status, 'passed', result.failure);
});

test('mixer validates handles, modes and output ranges without allocating handles or changing output', () => {
  const r = setup(),
    pointer = r.allocate(512),
    originalHandles = r.handles.size;
  r.write32(pointer, 0xdeadbeef);
  for (const [args, expected] of [
    [[pointer, 1, 0, 0, 0], 2],
    [[0, 0, 0, 0, 0], 11],
    [[pointer, 0, 0, 0, 0x80000], 10],
    [[pointer, 0, 0, 0, 0x10000], 8],
  ]) {
    assert.deepEqual(call(r, 'mixerOpen', args), { result: expected, argc: 5 });
    assert.equal(r.handles.size, originalHandles);
    assert.equal(r.read32(pointer), 0xdeadbeef);
  }
  assert.equal(call(r, 'mixerOpen', [pointer, 0, 0, 0, 0]).result, 0);
  const handle = r.read32(pointer);
  assert.equal(call(r, 'mixerClose', [handle]).result, 0);
  assert.equal(call(r, 'mixerGetID', [handle, pointer, 0x80000000]).result, 5);
  assert.equal(call(r, 'mixerGetID', [0, pointer, 0x10000000]).result, 10);
  assert.equal(call(r, 'mixerGetLineInfoA', [0, pointer, 0]).result, 11);
  r.data.fill(0xaa, pointer, pointer + 512);
  assert.equal(call(r, 'mixerGetDevCapsW', [0, pointer, 4]).result, 0);
  assert.equal(r.data[pointer + 4], 0xaa, 'short caps query does not overrun its requested size');
});

test('mixer control failures are atomic and source/master volume multiply without modifying input', () => {
  const r = setup(),
    descriptor = r.allocate(24),
    value = r.allocate(4);
  [24, 0, 1, 0, 4, value].forEach((n, i) => r.write32(descriptor + i * 4, n));
  const set = (id, n) => {
    r.write32(descriptor + 4, id);
    r.write32(value, n);
    return call(r, 'mixerSetControlDetails', [0, descriptor, 0]).result;
  };
  assert.equal(set(0, 32768), 0);
  assert.equal(set(2, 16384), 0);
  for (const [id, n, status] of [
    [0, 65536, 1026],
    [1, 2, 1026],
    [4, 1, 1025],
  ])
    assert.equal(set(id, n), status);
  const wave = { samples: [new Float32Array([1, -1])] };
  const result = applyMixerGain(r, wave);
  assert.ok(Math.abs(result.samples[0][0] - (32768 / 65535) * (16384 / 65535)) < 1e-7);
  assert.deepEqual([...wave.samples[0]], [1, -1]);
  assert.equal(set(3, 1), 0);
  assert.deepEqual([...applyMixerGain(r, wave).samples[0]], [0, -0]);
  assert.equal(call(r, 'mixerGetControlDetailsW', [0, descriptor, 1]).result, 8);
});
