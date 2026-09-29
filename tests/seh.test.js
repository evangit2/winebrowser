import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_BYTES,
  CONTEXT_OFFSETS,
  EXCEPTION_CODE,
  ExceptionContinueExecution,
  ExceptionContinueSearch,
  EXCEPTION_MAXIMUM_PARAMETERS,
  EXCEPTION_RECORD_BYTES,
  GuestFault,
  deliverGuestException,
  isGuestFault,
  readContext,
  readRegistrationChain,
  writeContext,
  writeExceptionRecord,
} from '../src/seh.js';

// A flat guest-memory model with the accessors the SEH walker expects.
function memory(bytes = 4096) {
  const data = new Uint8Array(bytes);
  const view = new DataView(data.buffer);
  return {
    data,
    read32: (pointer) => view.getUint32(pointer >>> 0, true) >>> 0,
    write32: (pointer, value) => view.setUint32(pointer >>> 0, value >>> 0, true),
    writeBytes(pointer, values) {
      data.set(values, pointer);
    },
  };
}

function registers(values = {}) {
  const r = Array.from({ length: 8 }, () => ({ value: 0 }));
  for (const [index, value] of Object.entries(values)) r[Number(index)].value = value >>> 0;
  return r;
}

const FS_BASE = 0x100;

test('reads a registration chain and stops at the terminator', () => {
  const m = memory();
  // fs:[0] -> frame 0x200 -> frame 0x220 -> 0xffffffff
  m.write32(FS_BASE, 0x200);
  m.write32(0x200, 0x220);
  m.write32(0x204, 0x8000);
  m.write32(0x220, 0xffffffff);
  m.write32(0x224, 0x9000);
  const chain = readRegistrationChain(m.read32, FS_BASE);
  assert.deepEqual(chain, [
    { frame: 0x200, next: 0x220, handler: 0x8000 },
    { frame: 0x220, next: 0xffffffff, handler: 0x9000 },
  ]);
});

test('an empty chain is reported as no frames', () => {
  const m = memory();
  m.write32(FS_BASE, 0xffffffff);
  assert.deepEqual(readRegistrationChain(m.read32, FS_BASE), []);
  const zero = memory();
  zero.write32(FS_BASE, 0);
  assert.deepEqual(readRegistrationChain(zero.read32, FS_BASE), []);
});

test('a self-referential chain terminates instead of looping', () => {
  const m = memory();
  m.write32(FS_BASE, 0x200);
  m.write32(0x200, 0x200);
  m.write32(0x204, 0x8000);
  const chain = readRegistrationChain(m.read32, FS_BASE);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].frame, 0x200);
});

test('writes the documented EXCEPTION_RECORD fields', () => {
  const m = memory();
  writeExceptionRecord(m.write32, 0x400, {
    code: EXCEPTION_CODE.ACCESS_VIOLATION,
    faultEip: 0x401234,
    faultAddress: 0xdeadbeef,
    write: true,
  });
  assert.equal(m.read32(0x400), 0xc0000005);
  assert.equal(m.read32(0x404), 0);
  assert.equal(m.read32(0x408), 0);
  assert.equal(m.read32(0x40c), 0x401234);
  assert.equal(m.read32(0x410), 2);
  assert.equal(m.read32(0x414), 1, 'a write fault sets ExceptionInformation[0]');
  assert.equal(m.read32(0x418), 0xdeadbeef);
  // The remaining 13 parameter slots are zeroed.
  for (let i = 2; i < EXCEPTION_MAXIMUM_PARAMETERS; i++) assert.equal(m.read32(0x414 + i * 4), 0);
  assert.equal(EXCEPTION_RECORD_BYTES, 80);
});

test('a read fault reports access 0', () => {
  const m = memory();
  writeExceptionRecord(m.write32, 0x400, {
    code: EXCEPTION_CODE.ACCESS_VIOLATION,
    faultEip: 0x1000,
    faultAddress: 0x24,
    write: false,
  });
  assert.equal(m.read32(0x414), 0);
});

test('writes and reads a full i386 CONTEXT round trip', () => {
  const m = memory();
  const cpu = { r: registers({ 0: 0x1111, 1: 0x2222, 2: 0x3333, 3: 0x4444, 4: 0x7fff0, 5: 0x7fff8, 6: 0x6666, 7: 0x7777 }) };
  writeContext(m.write32, 0x400, cpu, 0x401000, 0x200000);
  // The documented offsets must be exactly what the structure uses.
  assert.equal(m.read32(0x400 + CONTEXT_OFFSETS.Eax), 0x1111);
  assert.equal(m.read32(0x400 + CONTEXT_OFFSETS.Ecx), 0x2222);
  assert.equal(m.read32(0x400 + CONTEXT_OFFSETS.Edx), 0x3333);
  assert.equal(m.read32(0x400 + CONTEXT_OFFSETS.Ebx), 0x4444);
  assert.equal(m.read32(0x400 + CONTEXT_OFFSETS.Esp), 0x7fff0);
  assert.equal(m.read32(0x400 + CONTEXT_OFFSETS.Ebp), 0x7fff8);
  assert.equal(m.read32(0x400 + CONTEXT_OFFSETS.Esi), 0x6666);
  assert.equal(m.read32(0x400 + CONTEXT_OFFSETS.Edi), 0x7777);
  assert.equal(m.read32(0x400 + CONTEXT_OFFSETS.Eip), 0x401000);
  assert.equal(m.read32(0x400 + CONTEXT_OFFSETS.SegFs), 0x200000);
  assert.equal(m.read32(0x400 + CONTEXT_OFFSETS.ContextFlags) & 0x00010000, 0x00010000);
  assert.equal(CONTEXT_BYTES, 0xcc + 512);
  // The control registers follow the integer registers, matching winnt.h.
  assert.ok(CONTEXT_OFFSETS.Eip > CONTEXT_OFFSETS.Ebp);
  assert.equal(CONTEXT_OFFSETS.Esp, CONTEXT_OFFSETS.Eip + 12);
  assert.equal(CONTEXT_OFFSETS.SegSs, CONTEXT_OFFSETS.Esp + 4);
  // A handler that repairs registers and EIP must be able to write them back.
  m.write32(0x400 + CONTEXT_OFFSETS.Eax, 0xabcd);
  m.write32(0x400 + CONTEXT_OFFSETS.Eip, 0x402000);
  const restored = { r: registers() };
  readContext(m.read32, 0x400, restored);
  assert.equal(restored.r[0].value, 0xabcd);
  assert.equal(restored.r[4].value, 0x7fff0);
});

test('GuestFault carries the delivery fields and is recognised', () => {
  const fault = new GuestFault('Guest read violation at 0x24', {
    code: EXCEPTION_CODE.ACCESS_VIOLATION,
    address: 0x24,
    write: false,
    size: 4,
  });
  assert.equal(fault.sehCode, 0xc0000005);
  assert.equal(fault.sehAddress, 0x24);
  assert.equal(fault.sehWrite, false);
  assert.equal(isGuestFault(fault), true);
  assert.equal(isGuestFault(new Error('host failure')), false);
  assert.equal(isGuestFault(Object.assign(new Error('x'), { sehCode: 1, sehAddress: 2 })), true);
});

test('an empty chain is not handled, so a genuine fault still stops the run', async () => {
  const m = memory();
  m.write32(FS_BASE, 0xffffffff);
  const result = await deliverGuestException({
    read32: m.read32,
    write32: m.write32,
    cpu: { r: registers() },
    fsBase: FS_BASE,
    allocate: () => 0x800,
    callHandler: async () => {
      throw Error('a handler must not be called for an empty chain');
    },
    fault: new GuestFault('x', { address: 1 }),
  });
  assert.deepEqual(result, { handled: false, frames: 0 });
});

test('the first handler that continues execution wins and its context is applied', async () => {
  const m = memory();
  m.write32(FS_BASE, 0x200);
  m.write32(0x200, 0xffffffff);
  m.write32(0x204, 0x8000);
  const calls = [];
  const cpu = { r: registers({ 0: 7, 4: 0x5000 }) };
  const result = await deliverGuestException({
    read32: m.read32,
    write32: m.write32,
    cpu,
    fsBase: FS_BASE,
    allocate: (bytes) => (bytes === EXCEPTION_RECORD_BYTES ? 0x800 : 0x900),
    callHandler: async (handler, args) => {
      calls.push({ handler, args });
      // Repair EAX and resume after the faulting instruction.
      m.write32(0x900 + CONTEXT_OFFSETS.Eax, 0x1234);
      m.write32(0x900 + CONTEXT_OFFSETS.Eip, 0x402000);
      return ExceptionContinueExecution;
    },
    fault: new GuestFault('Guest read violation', {
      address: 0xdeadbeef,
      faultEip: 0x401000,
    }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].handler, 0x8000);
  // The handler receives (record, frame, context, dispatcher).
  assert.deepEqual(calls[0].args, [0x800, 0x200, 0x900, 0]);
  assert.equal(m.read32(0x800), 0xc0000005);
  assert.equal(m.read32(0x818), 0xdeadbeef);
  assert.deepEqual(result, { handled: true, resume: 0x402000, frames: 1 });
  assert.equal(cpu.r[0].value, 0x1234, 'the repaired EAX reached the CPU');
});

test('a handler that searches moves to the next frame in the chain', async () => {
  const m = memory();
  m.write32(FS_BASE, 0x200);
  m.write32(0x200, 0x220);
  m.write32(0x204, 0x8000);
  m.write32(0x220, 0xffffffff);
  m.write32(0x224, 0x9000);
  const seen = [];
  const cpu = { r: registers() };
  const result = await deliverGuestException({
    read32: m.read32,
    write32: m.write32,
    cpu,
    fsBase: FS_BASE,
    allocate: (bytes) => (bytes === EXCEPTION_RECORD_BYTES ? 0x400 : 0x500),
    callHandler: async (handler) => {
      seen.push(handler);
      if (handler === 0x8000) return ExceptionContinueSearch;
      m.write32(0x500 + CONTEXT_OFFSETS.Eip, 0x403000);
      return ExceptionContinueExecution;
    },
    fault: new GuestFault('x', { address: 0x10, faultEip: 0x1000 }),
  });
  assert.deepEqual(seen, [0x8000, 0x9000]);
  assert.deepEqual(result, { handled: true, resume: 0x403000, frames: 2 });
});

test('every handler declining reports not handled with the frame count', async () => {
  const m = memory();
  m.write32(FS_BASE, 0x200);
  m.write32(0x200, 0xffffffff);
  m.write32(0x204, 0x8000);
  const result = await deliverGuestException({
    read32: m.read32,
    write32: m.write32,
    cpu: { r: registers() },
    fsBase: FS_BASE,
    allocate: (bytes) => (bytes === EXCEPTION_RECORD_BYTES ? 0x400 : 0x500),
    callHandler: async () => ExceptionContinueSearch,
    fault: new GuestFault('x', { address: 0x10, faultEip: 0x1000 }),
  });
  assert.deepEqual(result, { handled: false, frames: 1 });
});

// End-to-end delivery through a real CPU: a block that faults on an unmapped
// address must name the faulting instruction and be offered to the chain.
test('a real faulting instruction is offered to the chain with its address', async () => {
  const { CPU } = await import('../src/cpu.js');
  const { GuestMemory } = await import('../src/memory.js');
  const iced = (await import('iced-x86')).default;
  const memory = new WebAssembly.Memory({ initial: 1 });
  // mov eax, [0x2000] (mov eax,[disp32]); the address is unmapped, so the
  // checked host load raises a GuestFault that records this instruction's IP.
  const code = [0xa1, 0x00, 0x20, 0x00, 0x00];
  new Uint8Array(memory.buffer).set([...code, 0xeb, 0], 0x1000);
  const regions = [
    { start: 0x1000, end: 0x2000, exec: true, read: true },
    { start: 0x8000, end: 0x9000, write: true, read: true },
  ];
  const guest = new GuestMemory(memory, regions);
  const cpu = new CPU(iced, {
    memory,
    stackTop: 0x9000,
    executableRanges: [[0x1000, 0x1000 + code.length + 2]],
    read32: (a) => guest.read32(a),
    write32: (a, v) => guest.write32(a, v),
    read: (a, w) => guest.read(a, w),
    write: (a, v, w) => guest.write(a, v, w),
    check: (a, n, write) => guest.check(a, n, write),
  });
  assert.throws(() => cpu.step(0x1000), (error) => {
    assert.equal(isGuestFault(error), true);
    assert.equal(error.sehCode, EXCEPTION_CODE.ACCESS_VIOLATION);
    return true;
  });
  // The faulting instruction's own address was recorded before the access, so
  // the exception record can name it rather than the block's start.
  assert.equal(cpu.instructionIp, 0x1000);
});

test('an instruction without memory operands does not clobber the fault address', async () => {
  const { CPU } = await import('../src/cpu.js');
  const { GuestMemory } = await import('../src/memory.js');
  const iced = (await import('iced-x86')).default;
  const memory = new WebAssembly.Memory({ initial: 1 });
  // mov eax, [0x2000] faults; nop; add eax, ecx; ret
  const code = [0xa1, 0x00, 0x20, 0x00, 0x00, 0x90, 0x01, 0xc8, 0xc3];
  new Uint8Array(memory.buffer).set(code, 0x1000);
  const regions = [
    { start: 0x1000, end: 0x2000, exec: true, read: true },
    { start: 0x8000, end: 0x9000, write: true, read: true },
  ];
  const guest = new GuestMemory(memory, regions);
  const cpu = new CPU(iced, {
    memory,
    stackTop: 0x9000,
    executableRanges: [[0x1000, 0x1000 + code.length + 2]],
    read32: (a) => guest.read32(a),
    write32: (a, v) => guest.write32(a, v),
    read: (a, w) => guest.read(a, w),
    write: (a, v, w) => guest.write(a, v, w),
    check: (a, n, write) => guest.check(a, n, write),
  });
  // Seed a plausible previous IP; a register-only block must not change it, so
  // a fault reported later still names the memory instruction that faulted.
  cpu.instructionIpGlobal.value = 0x1234;
  let faulted = false;
  try {
    cpu.step(0x1000);
  } catch (error) {
    faulted = true;
    assert.equal(isGuestFault(error), true);
  }
  assert.equal(faulted, true);
  assert.equal(cpu.instructionIp, 0x1000);
});

test('an unwind walk reaches the accepting frame with EXCEPTION_UNWINDING set', async () => {
  const { unwindExceptionChain, EXCEPTION_UNWINDING } = await import('../src/seh.js');
  const m = memory(8192);
  m.write32(FS_BASE, 0x200);
  m.write32(0x200, 0x220);
  m.write32(0x204, 0x8000); // inner frame, the one being left
  m.write32(0x220, 0xffffffff);
  m.write32(0x224, 0x9000); // outer frame, not reached
  const cpu = { r: registers({ 0: 0x9, 4: 0x5000 }) };
  const seen = [];
  const result = await unwindExceptionChain({
    read32: m.read32,
    write32: m.write32,
    cpu,
    fsBase: FS_BASE,
    allocate: (bytes) => (bytes === EXCEPTION_RECORD_BYTES ? 0x400 : 0x600),
    callHandler: async (handler, args) => {
      seen.push({ handler, flags: m.read32(0x404), esp: m.read32(0x600 + CONTEXT_OFFSETS.Esp) });
      return ExceptionContinueSearch;
    },
    // RtlUnwind unwinds every frame between the chain head and (but not
    // including) end_frame, so passing the outer frame walks the inner one.
    endFrame: 0x220,
    resumeEsp: 0x7000,
    retval: 0x42,
    faultEip: 0x401000,
  });
  // Only the inner frame is walked; the walk stops at the accepting frame.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].handler, 0x8000);
  assert.equal((seen[0].flags & EXCEPTION_UNWINDING) !== 0, true);
  assert.equal(seen[0].esp, 0x7000, 'the handler runs on the caller resume stack');
  assert.equal(m.read32(0x400), 0xc0000027, 'a record-less unwind is STATUS_UNWIND');
  assert.equal(cpu.r[0].value, 0x42, 'RtlUnwind puts retval in EAX');
  assert.deepEqual(result, { delivered: 1, frames: 2 });
});

test('an unwind handler returning a bad disposition is rejected', async () => {
  const { unwindExceptionChain } = await import('../src/seh.js');
  const m = memory(8192);
  m.write32(FS_BASE, 0x200);
  m.write32(0x200, 0xffffffff);
  m.write32(0x204, 0x8000);
  await assert.rejects(
    unwindExceptionChain({
      read32: m.read32,
      write32: m.write32,
      cpu: { r: registers() },
      fsBase: FS_BASE,
      allocate: (bytes) => (bytes === EXCEPTION_RECORD_BYTES ? 0x400 : 0x600),
      callHandler: async () => ExceptionContinueExecution,
      endFrame: 0,
      resumeEsp: 0x7000,
      retval: 0,
      faultEip: 0,
    }),
    /Invalid disposition from an unwind handler/,
  );
});
