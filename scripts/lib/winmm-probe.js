import { Runtime } from '../../src/runtime.js';

export function mixerWave() {
  const bytes = new Uint8Array(52),
    view = new DataView(bytes.buffer);
  const tag = (offset, text) => bytes.set(new TextEncoder().encode(text), offset);
  tag(0, 'RIFF');
  view.setUint32(4, 44, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, 8, true);
  [-32768, 16384, 32767, -8192].forEach((value, i) => view.setInt16(44 + i * 2, value, true));
  return bytes;
}

export async function probeWinmm(iced, { files }) {
  const pcm = [];
  const runtime = new Runtime(iced, {
    files,
    exe: 'mixer.exe',
    request: async (kind, payload) => {
      if (kind !== 'pcm') throw Error(`Unexpected request ${kind}`);
      pcm.push({
        sampleRate: payload.sampleRate,
        frames: payload.frames,
        samples: payload.samples.map((samples) => [...samples]),
      });
      return true; // Acknowledged by the diagnostic PCM sink, not a physical speaker.
    },
  });
  try {
    const result = await runtime.run();
    if (result.exitCode)
      throw Error(`Native mixer fixture failed at C source line ${result.exitCode}`);
    const gain = 32768 / 65535;
    const expected = [
      [-1, 32767 / 32768],
      [0.5, -0.25],
    ];
    if (pcm.length !== 2 || pcm.some((p) => p.sampleRate !== 8000 || p.frames !== 2))
      throw Error('PCM request shape mismatch');
    for (let channel = 0; channel < 2; channel++)
      for (let frame = 0; frame < 2; frame++) {
        if (Math.abs(pcm[0].samples[channel][frame] - expected[channel][frame] * gain) > 1e-7)
          throw Error('Native mixer volume did not change PCM output');
        if (pcm[1].samples[channel][frame] !== 0)
          throw Error('Native mixer mute did not silence PCM output');
      }
    return {
      status: 'passed',
      pcm,
      exitCode: result.exitCode,
      instructions: runtime.cpu.instructions,
      scope:
        'Native PE32 WinMM ABI and exact samples at the browser PCM driver boundary; no claim about physical speaker output.',
    };
  } catch (error) {
    return { status: 'failed', failure: error.message, pcm };
  }
}
