import { ComObjects, readGuid } from './com.js';
const BASE = '119e7452-de9e-40fe-8806-88f90c12b441';
const DEBUG1 = 'c5a05f0c-16f2-4adf-9f4d-a8c4d58ac550';
export const dxgiDebugApis = {
  'dxgi.dll!DXGIGetDebugInterface1': (r, a) => {
    const out = a(2) >>> 0;
    if (!out) return { result: 0x80070057, argc: 3 };
    r.check(out, 4, true);
    r.write32(out, 0);
    if (a(0)) return { result: 0x80070057, argc: 3 };
    if (![BASE, DEBUG1].includes(readGuid(r, a(1) >>> 0))) return { result: 0x80004002, argc: 3 };
    r.comObjects ??= new ComObjects(r);
    const thread = () => r.threads?.current ?? r;
    const debug = r.comObjects.create({
      name: 'IDXGIDebug1',
      iid: DEBUG1,
      iids: [BASE],
      methodNames: [
        'QueryInterface',
        'AddRef',
        'Release',
        'ReportLiveObjects',
        'EnableLeakTrackingForThread',
        'DisableLeakTrackingForThread',
        'IsLeakTrackingEnabledForThread',
      ],
      methods: {
        3: {
          argc: 6,
          invoke(r, a) {
            const all = [0xe48ae283, 0x490bda80, 0xe943e687, 0x08dacfa9];
            if (all.some((word, i) => a(i + 1) >>> 0 !== word) || a(5) & ~7) return 0x80070057;
            const live = [...r.comObjects.objects.values()].filter(
              (o) => o.refs && /^(ID3D12|IDXGI(?!Debug))/.test(o.name),
            );
            r.emit?.({ type: 'log', text: `DXGI live guest graphics objects: ${live.length}` });
            if (a(5) & 2)
              for (const o of live.slice(0, 64))
                r.emit?.({
                  type: 'log',
                  text: `${o.name} 0x${o.pointer.toString(16)} refs=${o.refs}`,
                });
            return 0;
          },
        },
        4: {
          argc: 1,
          invoke: () => {
            thread().dxgiLeakTracking = true;
            return 0;
          },
        },
        5: {
          argc: 1,
          invoke: () => {
            thread().dxgiLeakTracking = false;
            return 0;
          },
        },
        6: { argc: 1, invoke: () => Number(!!thread().dxgiLeakTracking) },
      },
    });
    r.write32(out, debug.pointer);
    return { result: 0, argc: 3 };
  },
};
