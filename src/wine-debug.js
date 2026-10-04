import { decodeAnsi } from './encoding.js';
import { CONTEXT_BYTES, CONTEXT_OFFSETS, EXCEPTION_RECORD_BYTES, readContext } from './seh.js';
import { restoreFxImage } from './x86-fxstate.js';

// Wine's OutputDebugString raises these two debugger notifications through
// NtRaiseException. Application exceptions enter the original Wine i386
// dispatcher, retaining guest SEH/C++ handlers, typed catches and unwinding.
function resumeContext(r, context) {
  r.check(context, CONTEXT_BYTES);
  const mask = r.read32(context),
    ip = r.read32(context + CONTEXT_OFFSETS.Eip),
    flags = r.read32(context + CONTEXT_OFFSETS.EFlags);
  if ((mask & 3) !== 3 || mask & 0x40) return 0xc00000bb;
  r.check(ip, 1);
  r.check(r.read32(context + CONTEXT_OFFSETS.Esp), 4);
  if (flags & 0x100) return 0xc00000bb;
  if (mask & 0x20) restoreFxImage(r.cpu, r.data.slice(context + 0xcc, context + CONTEXT_BYTES));
  readContext(r.read32.bind(r), context, r.cpu);
  r.cpu.host.flagByte(flags, 1);
  r.cpu.df = (flags >>> 10) & 1;
  r.cpu.f.of = (flags >>> 11) & 1;
  r.cpu.controlFlags = flags & 0x244000;
  return { result: r.cpu.r[0].value, jumpTo: ip };
}
export const debugNtServices = {
  NtContinue: {
    argc: 2,
    call(r, a) {
      if (a(1)) return 0xc00000bb; // Alertable continuation needs APC delivery.
      return resumeContext(r, a(0));
    },
  },
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
      if (![0x40010006, 0x4001000a].includes(code)) {
        const module = r.graph?.modules.get('ntdll.dll'),
          dispatcher = module?.pe?.exports.find(
            (e) => e.name === 'KiUserExceptionDispatcher' && !e.forwarder,
          );
        if (!module || module.host || !dispatcher || a(2) !== 1)
          throw Error(`Unsupported Wine NT exception 0x${code.toString(16)}`);
        if (count > 15) return 0xc000000d;
        const ip = module.base + dispatcher.rva;
        r.check(ip, 1);
        // Wine's i386 dispatcher starts with two pointers at ESP, without a
        // return address. Copy caller records below the current stack before
        // transferring control; native handlers own subsequent stack unwinds.
        const recordBytes = r.data.slice(record, record + EXCEPTION_RECORD_BYTES),
          contextBytes = r.data.slice(context, context + CONTEXT_BYTES),
          size = 8 + EXCEPTION_RECORD_BYTES + CONTEXT_BYTES,
          stack = ((r.cpu.r[4].value >>> 0) - size - 16) & ~15;
        r.check(stack, size, true);
        r.data.set(recordBytes, stack + 8);
        r.data.set(contextBytes, stack + 8 + EXCEPTION_RECORD_BYTES);
        r.write32(stack, stack + 8);
        r.write32(stack + 4, stack + 8 + EXCEPTION_RECORD_BYTES);
        r.cpu.r[4].value = stack;
        return { result: 0, jumpTo: ip };
      }
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
