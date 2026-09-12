// PE static TLS for the runtime's single guest thread. Dynamic TlsAlloc slots
// are a separate Windows facility and are not represented by this vector.
const TEB_TLS_VECTOR = 0x2e0002c;
const MAX_MODULES = 128;

export class StaticTLS {
  constructor(runtime) {
    this.runtime = runtime;
    this.vector = 0;
    this.records = new Map();
  }

  checkpoint() {
    return {
      vector: this.vector,
      records: new Map([...this.records].map(([module, record]) => [module, { ...record }])),
    };
  }

  prepare(modules) {
    const saved = this.checkpoint();
    const r = this.runtime;
    try {
      for (const module of modules) {
        const tls = module.pe?.tls;
        if (!tls || this.records.has(module)) continue;
        if (!this.vector) {
          this.vector = r.allocate(MAX_MODULES * 4);
          r.write32(TEB_TLS_VECTOR, this.vector);
        }
        const used = new Set([...this.records.values()].map((record) => record.index));
        let index = 0;
        while (used.has(index)) index++;
        if (index >= MAX_MODULES) throw Error('Static TLS module limit exceeded');
        const alignment = tls.alignment || 16;
        const size = tls.templateSize + tls.zeroFill;
        const indexAddress = module.base + tls.indexRva;
        const originalIndex = r.read32(indexAddress);
        const allocation = r.allocate(Math.max(size, 1) + alignment - 1);
        const pointer = Math.ceil(allocation / alignment) * alignment;
        this.records.set(module, {
          index,
          pointer,
          allocation,
          originalIndex,
          callbacksRun: 0,
          attached: false,
        });
        if (tls.templateSize) {
          const template = module.base + tls.templateRva;
          r.check(template, tls.templateSize);
          r.data.set(r.data.subarray(template, template + tls.templateSize), pointer);
        }
        r.write32(this.vector + index * 4, pointer);
        r.write32(indexAddress, index);
      }
    } catch (error) {
      this.restore(saved);
      throw error;
    }
  }

  async attach(module) {
    const record = this.records.get(module);
    if (!record || record.attached) return;
    for (const rva of module.pe.tls.callbackRvas) {
      if (this.runtime.exitCode !== null) return;
      await this.runtime.callGuest(module.base + rva, [module.base, 1, 0]);
      record.callbacksRun++;
    }
    record.attached = true;
  }

  async detach(module) {
    const record = this.records.get(module);
    if (!record || (!record.attached && !record.callbacksRun)) return;
    const count = record.callbacksRun;
    record.attached = false;
    record.callbacksRun = 0;
    for (const rva of module.pe.tls.callbackRvas.slice(0, count))
      await this.runtime.callGuest(module.base + rva, [module.base, 0, 0]);
  }

  restore(saved) {
    const r = this.runtime;
    for (const [module, record] of this.records) {
      if (saved.records.has(module)) continue;
      r.write32(module.base + module.pe.tls.indexRva, record.originalIndex);
      r.write32(this.vector + record.index * 4, 0);
      r.free(record.allocation);
    }
    if (this.vector && !saved.vector) r.free(this.vector);
    this.vector = saved.vector;
    this.records = new Map(
      [...saved.records].map(([module, state]) => {
        // A suspended TLS callback may still hold this record across a nested
        // LoadLibrary failure. Restore fields without replacing that object.
        const record = this.records.get(module) ?? {};
        Object.assign(record, state);
        return [module, record];
      }),
    );
    r.write32(TEB_TLS_VECTOR, this.vector);
  }
}
