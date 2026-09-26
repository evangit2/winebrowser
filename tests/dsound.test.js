import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { DS } from '../src/dsound.js';
import { DirectSoundMixer, mixSound, decibelGain } from '../src/dsound-mixer.js';
import { BrowserAudioStream } from '../src/browser-audio-stream.js';
import { inputState } from '../src/dinput-device.js';

const method = (r, p, slot, ...args) =>
  r.thunks.get(r.read32(r.read32(p) + slot * 4)).invoke(r, (i) => [p, ...args][i] >>> 0);
function format(r, channels = 1, rate = 1000, bits = 16) {
  const p = r.allocate(18),
    align = (channels * bits) / 8;
  r.view.setUint16(p, 1, true);
  r.view.setUint16(p + 2, channels, true);
  r.write32(p + 4, rate);
  r.write32(p + 8, rate * align);
  r.view.setUint16(p + 12, align, true);
  r.view.setUint16(p + 14, bits, true);
  r.view.setUint16(p + 16, 0, true);
  return p;
}
async function setup(t) {
  const bytes = new Uint8Array(await readFile('public/demos/console/console.exe'));
  let now = 0;
  const events = [],
    r = new Runtime(iced, {
      files: new Map([['console.exe', bytes]]),
      exe: 'console.exe',
      performanceNow: () => now * 1000,
      emit: (event) => events.push(event),
    });
  r.directSound = new DirectSoundMixer(r, { automatic: false });
  t.after(() => {
    r.directSound.dispose();
    r.windows.dispose();
    r.cpu.dispose();
  });
  const out = r.allocate(16);
  const api = (name, ...args) => r.apiProvider.get(`dsound.dll!${name}`)(r, (i) => args[i] >>> 0);
  assert.equal(api('DirectSoundCreate8', 0, out, 0).result, 0);
  const device = r.read32(out);
  await method(r, device, 6, 0x101, 2);
  const buffer = async ({ flags = 0xe0, size = 200, f = format(r) } = {}) => {
    const desc = r.allocate(36);
    r.data.fill(0, desc, desc + 36);
    [36, flags, size, 0, f].forEach((v, i) => r.write32(desc + i * 4, v));
    const result = await method(r, device, 3, desc, out, 0);
    return { result: result.result, pointer: r.read32(out), desc };
  };
  return { r, out, device, buffer, events, api, time: (v) => (now = v) };
}
test('DirectSound validates PCM, copies formats, bounds structures and preserves ordinal identity', async (t) => {
  const { r, out, device, buffer, api } = await setup(t);
  await r.loadLibrary('dsound.dll');
  const dll = r.graph.findLoaded('dsound.dll');
  assert.equal(await r.resolveExport(dll, 1), await r.resolveExport(dll, 'DirectSoundCreate'));
  assert.equal(await r.resolveExport(dll, 11), await r.resolveExport(dll, 'DirectSoundCreate8'));
  assert.equal(api('DirectSoundCreate', 0, out, 1).result, DS.NOAGGREGATION);
  assert.equal(r.read32(out), 0);
  const caps = r.allocate(104);
  r.data.fill(0xcc, caps, caps + 104);
  r.write32(caps, 104);
  assert.equal((await method(r, device, 4, caps)).result, 0);
  assert.equal(r.read32(caps), 104);
  assert.equal(r.read32(caps + 16), 1);
  assert.equal(r.read32(caps + 20), 0);
  assert.equal(r.read32(caps + 96), 0xcccccccc);
  const f = format(r),
    b = await buffer({ f });
  assert.equal(b.result, 0);
  r.view.setUint16(f, 3, true);
  assert.equal((await buffer({ f })).result, DS.BADFORMAT);
  assert.equal((await buffer({ flags: 0x10 })).result, DS.UNSUPPORTED);
  const dest = r.allocate(24);
  r.data.fill(0xcc, dest, dest + 24);
  assert.equal((await method(r, b.pointer, 5, dest, 18, out)).result, 0);
  assert.equal(r.read32(out), 18);
  assert.equal(r.view.getUint16(dest, true), 1);
  assert.equal(r.read32(dest + 18), 0xcccccccc);
  assert.equal((await method(r, b.pointer, 5, dest, 10, out)).result, DS.INVALID);
  assert.equal(r.read32(out), 10);
  assert.equal((await method(r, b.pointer, 5, 0, 0, out)).result, 0);
  assert.equal(r.read32(out), 18);
});

test('DirectSound locks split at wrap, ENTIREBUFFER keeps offset and duplicates share storage/lifetime', async (t) => {
  const { r, out, device, buffer } = await setup(t),
    { pointer } = await buffer({ size: 20 });
  const b = r.comObjects.objects.get(pointer).state,
    p = b.storage.pointer;
  const lock = async (offset, size, flags = 0) => {
    const reply = await method(
      r,
      pointer,
      11,
      offset,
      size,
      out,
      out + 4,
      out + 8,
      out + 12,
      flags,
    );
    assert.equal(reply.argc, 8);
    return { result: reply.result, values: [0, 4, 8, 12].map((n) => r.read32(out + n)) };
  };
  assert.deepEqual(await lock(16, 8), { result: 0, values: [p + 16, 4, p, 4] });
  assert.deepEqual(await lock(16, 999, 2), { result: 0, values: [p + 16, 4, p, 16] });
  assert.deepEqual(await lock(20, 1), { result: DS.INVALID, values: [0, 0, 0, 0] });
  assert.equal((await method(r, pointer, 19, p + 16, 4, p, 4)).result, 0);
  assert.equal((await method(r, pointer, 19, p + 16, 5, p, 4)).result, DS.INVALID);
  assert.equal((await method(r, device, 5, pointer, out)).result, 0);
  const copy = r.read32(out),
    duplicate = r.comObjects.objects.get(copy).state;
  assert.equal(duplicate.storage, b.storage);
  r.view.setInt16(p, 12345, true);
  await method(r, pointer, 15, -1000);
  assert.equal(duplicate.volume, 0);
  await method(r, pointer, 2);
  assert.equal(r.view.getInt16(duplicate.storage.pointer, true), 12345);
  assert.ok(r.allocations.has(p));
  await method(r, copy, 2);
  assert.equal(r.allocations.has(p), false);
});

test('PCM allocation failure returns an HRESULT with a null output and leaves the device usable', async (t) => {
  const { r, buffer } = await setup(t);
  const allocations = [];
  try {
    while (true) allocations.push(r.allocate(1024 * 1024));
  } catch (error) {
    assert.equal(error.message, 'Guest heap exhausted');
  }
  const failed = await buffer({ size: 1024 * 1024 });
  assert.equal(failed.result, DS.OUTOFMEMORY);
  assert.equal(failed.pointer, 0);
  allocations.forEach((p) => r.free(p));
  assert.equal((await buffer()).result, 0);
});

test('play cursors advance with time, wrap, stop, seek, resample and complete without API-driven stepping', async (t) => {
  const { r, out, buffer, time } = await setup(t),
    { pointer } = await buffer();
  const cursor = async () => {
    await method(r, pointer, 4, out, out + 4);
    return [r.read32(out), r.read32(out + 4)];
  };
  await method(r, pointer, 12, 0, 0, 1);
  time(0.025);
  assert.deepEqual(await cursor(), [50, 80]);
  r.directSound.pump();
  assert.deepEqual(await cursor(), [50, 80], 'mix ahead does not advance reported position');
  await method(r, pointer, 17, 2000);
  time(0.04);
  assert.deepEqual(await cursor(), [110, 170]);
  await method(r, pointer, 17, 0);
  await method(r, pointer, 8, out);
  assert.equal(r.read32(out), 1000);
  await method(r, pointer, 18);
  time(3);
  assert.deepEqual(await cursor(), [110, 110]);
  await method(r, pointer, 13, 199);
  assert.deepEqual(await cursor(), [198, 198]);
  await method(r, pointer, 12, 0, 0, 0);
  time(3.01);
  await method(r, pointer, 9, out);
  assert.equal(r.read32(out), 0);
  assert.deepEqual(await cursor(), [0, 0]);
  await method(r, pointer, 12, 0, 0, 1);
  time(3.235);
  assert.ok(Math.abs((await cursor())[0] - 50) <= 2);
  assert.equal((await method(r, pointer, 13, 200)).result, DS.INVALID);
});

test('PCM mixer linearly resamples mono/stereo, scales dB and pan, clips and obeys mute/focus', async (t) => {
  const { r, buffer } = await setup(t);
  const { pointer } = await buffer({ size: 4, f: format(r, 1, 1000, 8) });
  const b = r.comObjects.objects.get(pointer).state;
  r.data.set([128, 192, 0, 255], b.storage.pointer);
  await method(r, pointer, 12, 0, 0, 1);
  const render = () => mixSound(r, [b], 0, 4, 2000).samples;
  assert.deepEqual([...render()[0]], [0, 0.25, 0.5, -0.25]);
  await method(r, pointer, 15, -2000);
  await method(r, pointer, 16, 10000);
  assert.deepEqual([...render()[0]], [0, 0, 0, 0]);
  assert.ok(Math.abs(render()[1][2] - 0.05) < 1e-7);
  assert.equal(decibelGain(-10000), 0);
  inputState(r).focused = false;
  assert.deepEqual([...render()[1]], [0, 0, 0, 0]);
  b.flags |= 0x8000;
  assert.ok(render()[1][2] > 0);
  const stereo = await buffer({ size: 8, f: format(r, 2, 1000) });
  const s = r.comObjects.objects.get(stereo.pointer).state;
  [16384, -16384, 32767, -32768].forEach((v, i) =>
    r.view.setInt16(s.storage.pointer + i * 2, v, true),
  );
  r.directInput.focused = true;
  await method(r, stereo.pointer, 12, 0, 0, 1);
  const mixed = mixSound(r, [s, s, s], 0, 2, 1000).samples;
  assert.deepEqual([...mixed[0]], [1, 1]);
  assert.deepEqual([...mixed[1]], [-1, -1]);
  const noControls = await buffer({ flags: 0 });
  assert.equal((await method(r, noControls.pointer, 15, 0)).result, DS.CONTROL);
  assert.equal((await method(r, noControls.pointer, 17, 0)).result, DS.CONTROL);
});

test('primary format requires priority, primary identity is stable and the pump remains bounded after stalls', async (t) => {
  const { r, out, device, buffer, events, time } = await setup(t);
  const primary = await buffer({ flags: 0x81, size: 0, f: 0 });
  assert.equal(primary.result, 0);
  assert.equal((await buffer({ flags: 1, size: 0, f: 0 })).pointer, primary.pointer);
  await method(r, device, 6, 0x101, 1);
  assert.equal((await method(r, primary.pointer, 14, format(r))).result, DS.PRIORITY);
  await method(r, device, 6, 0x101, 2);
  assert.equal((await method(r, primary.pointer, 14, format(r))).result, 0);
  const { pointer } = await buffer();
  await method(r, pointer, 12, 0, 0, 1);
  r.directSound.pump();
  assert.equal(events.length, 2);
  events.length = 0;
  time(100);
  r.directSound.pump();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'audio-stream');
  await method(r, primary.pointer, 9, out);
  assert.equal(r.read32(out), 5);
  r.directSound.dispose();
  assert.equal(events.at(-1).type, 'audio-stream-stop');
});

test('Web Audio stream schedules real sources, bounds queue length and disconnects on stop', () => {
  const made = [],
    context = {
      currentTime: 1,
      state: 'running',
      destination: {},
      createBuffer: (channels, frames, rate) => ({ channels, frames, rate, copyToChannel() {} }),
      createBufferSource() {
        const source = {
          connect: () => gain,
          start: (v) => (source.startTime = v),
          stop: () => (source.stopped = true),
          disconnect: () => (source.disconnected = true),
        };
        const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
        made.push(source);
        return source;
      },
      createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    };
  const player = new BrowserAudioStream(),
    wave = { samples: [new Float32Array(1024)], frames: 1024, sampleRate: 44100 };
  for (let i = 0; i < 20; i++) player.write(context, wave);
  assert.equal(made.length, 20);
  assert.ok(made.some((s) => s.stopped && s.disconnected));
  assert.ok(player.nextTime < context.currentTime + 0.2);
  assert.ok(made.at(-1).startTime >= 1.02);
  context.state = 'suspended';
  assert.equal(player.write(context, wave), false);
  assert.equal(player.sources.size, 0);
  assert.equal(player.nextTime, 0);
});
