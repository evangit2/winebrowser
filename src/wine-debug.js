import { decodeAnsi } from './encoding.js';
import { CONTEXT_BYTES, CONTEXT_OFFSETS, readContext } from './seh.js';
import { restoreFxImage } from './x86-fxstate.js';

// Wine's OutputDebugString raises these two debugger notifications through
// NtRaiseException. The browser log is the debug sink; application exceptions
// stay explicit until their native NT dispatch is implemented.
export const debugNtServices = {
  NtRaiseException: {
    argc: 3,
    call(r, a) {
      const record = a(0) >>> 0,
        context = a(1) >>> 0;
      r.check(record, 80);
      r.check(context, CONTEXT_BYTES);
      const code = r.read32(record),
        count = r.read32(record + 16);
      const wide = code === 0x4001000a;
      if (a(2) !== 1 || ![0x40010006, 0x4001000a].includes(code) || count !== (wide ? 4 : 2))
        throw Error(`Unsupported Wine NT exception 0x${code.toString(16)}`);
      const length = r.read32(record + 20),
        pointer = r.read32(record + 24),
        unit = wide ? 2 : 1;
      if (!length || length > 32768) return 0xc000000d;
      r.check(pointer, length * unit);
      const bytes = r.data.subarray(pointer, pointer + length * unit);
      if (bytes[bytes.length - 1] || (wide && bytes[bytes.length - 2])) return 0xc000000d;
      const payload = bytes.subarray(0, bytes.length - unit);
      const text = wide ? new TextDecoder('utf-16le').decode(payload) : decodeAnsi(payload);
      const ip = r.read32(context + CONTEXT_OFFSETS.Eip),
        flags = r.read32(context + CONTEXT_OFFSETS.EFlags);
      r.check(ip, 1);
      r.check(r.read32(context + CONTEXT_OFFSETS.Esp), 4);
      if (flags & 0x100) throw Error('Debug context single-step mode is unsupported');
      if (r.read32(context) & 0x20)
        restoreFxImage(r.cpu, r.data.slice(context + 0xcc, context + CONTEXT_BYTES));
      readContext(r.read32.bind(r), context, r.cpu);
      r.cpu.host.flagByte(flags, 1);
      r.cpu.df = (flags >>> 10) & 1;
      r.cpu.f.of = (flags >>> 11) & 1;
      r.cpu.controlFlags = flags & 0x244000;
      r.emit({ type: 'stdout', text });
      // A handled NtRaiseException resumes the saved context. Returning a
      // success status would make native RtlRaiseException call RtlRaiseStatus.
      return { result: r.cpu.r[0].value, jumpTo: ip };
    },
  },
};
