import { PROCESS_LAYOUT } from './process-layout.js';
import { SectionViewStatus } from './section-views.js';
import { VirtualMemoryConstants as VM } from './virtual-memory.js';

// Wine 11 include/winternl.h: PE32 PEB fields 0x58/0x5c/0x60.
export const PEB_NLS_POINTERS = Object.freeze({
  ansi: PROCESS_LAYOUT.peb + 0x58,
  oem: PROCESS_LAYOUT.peb + 0x5c,
  caseTable: PROCESS_LAYOUT.peb + 0x60,
});

// Wine 11 CPTABLEINFO: seven USHORTs, 12 lead bytes, two padding bytes,
// then four 32-bit pointers = 44 bytes. NLSTABLEINFO contains two such
// structures followed by UpperCaseTable and LowerCaseTable pointers.
export const NLS_TABLE_INFO_SIZE = 96;

const REQUIRED_FILES = [
  ['ansi', 'c_1252.nls'],
  ['oem', 'c_437.nls'],
  ['caseTable', 'l_intl.nls'],
];

function directExport(module, name) {
  const entry = module.pe.exports.find((item) => item.name === name);
  if (!entry || entry.forwarder) throw Error(`Wine NLS bootstrap requires direct ${name} export`);
  return module.base + entry.rva;
}

/** Restore PEB fields and release only the views mapped by this bootstrap. */
export function cleanupWineNlsProcess(runtime, state) {
  if (!state?.initialized) return;
  for (const [address, value] of state.previousPointers) runtime.write32(address, value);
  for (const base of [...state.mappedBases].reverse()) runtime.sectionViews.unmap(base);
  state.initialized = false;
}

/**
 * Publish immutable NLS sections to an unchanged Wine ntdll before DLL attach.
 * Wine's own RtlInitNlsTables and RtlResetRtlTranslations build translation
 * tables; the host owns only the sections and the PE32 PEB pointers.
 */
export async function initializeWineNlsProcess(runtime, module) {
  const resources = runtime.nls.files;
  if (!resources.size) return { initialized: false, mappedBases: [], previousPointers: [] };
  for (const [, filename] of REQUIRED_FILES)
    if (!resources.has(filename)) throw Error(`Wine NLS bootstrap requires ${filename}`);

  const init = directExport(module, 'RtlInitNlsTables');
  const reset = directExport(module, 'RtlResetRtlTranslations');
  const previousPointers = Object.values(PEB_NLS_POINTERS).map((address) => [
    address,
    runtime.read32(address),
  ]);
  const mappedBases = [];
  let scratch = 0;
  try {
    const mapped = {};
    for (const [field, filename] of REQUIRED_FILES) {
      const view = runtime.sectionViews.map(resources.get(filename), { name: filename });
      if (view.status !== SectionViewStatus.SUCCESS)
        throw Error(`Wine NLS bootstrap could not map ${filename}: 0x${view.status.toString(16)}`);
      mapped[field] = view.base;
      mappedBases.push(view.base);
    }
    const reservation = runtime.virtualMemory.allocate(
      0,
      VM.pageSize,
      VM.MEM_COMMIT | VM.MEM_RESERVE,
      VM.PAGE_READWRITE,
    );
    if (reservation.status) throw Error('Wine NLS bootstrap could not allocate table scratch');
    scratch = reservation.base;
    runtime.data.fill(0, scratch, scratch + NLS_TABLE_INFO_SIZE);
    for (const [field] of REQUIRED_FILES) runtime.write32(PEB_NLS_POINTERS[field], mapped[field]);
    await runtime.callGuest(init, [mapped.ansi, mapped.oem, mapped.caseTable, scratch]);
    await runtime.callGuest(reset, [scratch]);
    return { initialized: true, mappedBases, previousPointers };
  } catch (error) {
    for (const [address, value] of previousPointers) runtime.write32(address, value);
    for (const base of mappedBases.reverse()) runtime.sectionViews.unmap(base);
    throw error;
  } finally {
    if (scratch) runtime.virtualMemory.free(scratch, 0, VM.MEM_RELEASE);
  }
}
