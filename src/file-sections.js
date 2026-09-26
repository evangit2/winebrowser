import { VirtualMemoryConstants as VM } from './virtual-memory.js';

export const SECTION = Object.freeze({
  SUCCESS: 0,
  FAULT: 0xc0000005,
  HANDLE: 0xc0000008,
  INVALID: 0xc000000d,
  MEMORY: 0xc0000017,
  VIEW_SIZE: 0xc000001f,
  ACCESS: 0xc0000022,
  TOO_BIG: 0xc0000040,
  PROTECTION: 0xc000004e,
  UNSUPPORTED: 0xc00000bb,
  EMPTY: 0xc000011e,
  ALIGNMENT: 0xc0000220,
  USER_MAPPED_FILE: 0xc0000243,
  ALL: 0xf001f,
  QUERY: 1,
  READ: 4,
  COMMIT: 0x08000000,
  FILE: 0x00800000,
});
const HANDLE_BASE = 0x54000000,
  HANDLE_END = 0x55000000;
const roundPage = (size) => Math.ceil(size / VM.pageSize) * VM.pageSize;
export const fileSections = (r) => (r.fileSections ??= new FileSections(r));

// Unnamed data-file sections. Handles and views independently retain the object.
// File bytes remain authoritative; ordinary file writes refresh every read-only
// alias. Writable/COW/image/pagefile sections require separate memory semantics.
export class FileSections {
  constructor(runtime) {
    this.runtime = runtime;
    this.nextHandle = HANDLE_BASE;
    this.objects = new Set();
  }
  lookup(handle, access = 0) {
    const opened = this.runtime.handles.get(handle >>> 0);
    if (opened?.kind !== 'file-section') return { status: SECTION.HANDLE };
    if ((opened.access & access) !== access) return { status: SECTION.ACCESS };
    return { status: 0, object: opened.object };
  }
  create({
    file,
    size = 0n,
    protection = 2,
    attributes = SECTION.COMMIT,
    access = SECTION.ALL,
    inherit = false,
  }) {
    const r = this.runtime;
    if (attributes !== SECTION.COMMIT || protection !== 2 || !file)
      return { status: SECTION.UNSUPPORTED };
    // Expand generic rights without pretending that granting a handle right
    // makes an incompatible view protection valid for the section.
    let rights = access & 0x0fffffff;
    if (access & 0x10000000 || access & 0x02000000) rights |= SECTION.ALL;
    rights &= ~0x02000000;
    if (access & 0x80000000) rights |= 0x20005;
    if (access & 0x40000000) rights |= 0x20002;
    if (access & 0x20000000) rights |= 0x20008;
    if (rights & ~SECTION.ALL) return { status: SECTION.ACCESS };
    const opened = r.handles.get(file >>> 0);
    if (!opened || opened.kind || !r.files.has(opened.path)) return { status: SECTION.HANDLE };
    if (!(opened.access & 0x80000000)) return { status: SECTION.ACCESS };
    const bytes = r.files.get(opened.path);
    if (typeof size !== 'bigint' || size < 0n) return { status: SECTION.INVALID };
    if (size > BigInt(bytes.length)) return { status: SECTION.TOO_BIG };
    const length = Number(size) || bytes.length;
    if (!length) return { status: SECTION.EMPTY };
    if (this.objects.size >= 256 || r.handles.size >= 4096 || this.nextHandle >= HANDLE_END)
      return { status: SECTION.MEMORY };
    const object = { path: opened.path, size: length, handles: 1, views: new Map() };
    const handle = this.nextHandle;
    this.nextHandle += 4;
    this.objects.add(object);
    r.handles.set(handle, { kind: 'file-section', object, access: rights, inherit });
    return { status: 0, handle };
  }
  map(handle, { base = 0, offset = 0n, size = 0, protection = 2 } = {}) {
    const found = this.lookup(handle, SECTION.READ);
    if (found.status) return found;
    if (protection !== 2) return { status: SECTION.PROTECTION };
    if (
      !Number.isSafeInteger(base) ||
      base < 0 ||
      base > 0xffffffff ||
      typeof offset !== 'bigint' ||
      offset < 0n ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 0xffffffff
    )
      return { status: SECTION.INVALID };
    if (base % VM.allocationGranularity || offset % BigInt(VM.allocationGranularity))
      return { status: SECTION.ALIGNMENT };
    const { object } = found;
    if (offset >= BigInt(object.size) || (size && offset + BigInt(size) > BigInt(object.size)))
      return { status: SECTION.VIEW_SIZE };
    const start = Number(offset),
      length = size || object.size - start;
    const mappedSize = roundPage(length),
      r = this.runtime;
    // A view maps whole pages, including file content in the last partial page.
    // Only bytes past the actual file's EOF are zero-filled by SectionViews.
    const bytes = r.files.get(object.path).subarray(start, start + mappedSize);
    const result = r.sectionViews.map(bytes, {
      base,
      name: object.path,
      onUnmap: () => {
        object.views.delete(result.base);
        this.collect(object);
      },
    });
    if (result.status) return result;
    object.views.set(result.base, { offset: start, size: result.mappedSize });
    return { ...result, offset, size: result.mappedSize };
  }
  close(handle) {
    handle >>>= 0;
    if (handle < HANDLE_BASE || handle >= this.nextHandle) return null;
    const found = this.lookup(handle);
    if (found.status) return found.status;
    this.runtime.handles.delete(handle);
    found.object.handles--;
    this.collect(found.object);
    return 0;
  }
  collect(object) {
    if (!object.handles && !object.views.size) this.objects.delete(object);
  }
  canResize(path, size) {
    // Growing is safe: existing sections keep their original maximum size.
    // Do not invalidate a live data section by truncating its backing file.
    return (
      size >= this.runtime.files.get(path).length ||
      ![...this.objects].some((object) => object.path === path)
    );
  }
  fileChanged(path) {
    const bytes = this.runtime.files.get(path);
    for (const object of this.objects) {
      if (object.path !== path) continue;
      for (const [base, view] of object.views) {
        this.runtime.data.fill(0, base, base + view.size);
        this.runtime.data.set(bytes.subarray(view.offset, view.offset + view.size), base);
      }
    }
  }
}
