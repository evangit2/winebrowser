#include "counter.h"

static ULONG factory_refs, objects, locks;
static BOOL attached;
static BOOL equal(REFGUID a, REFGUID b)
{
    const BYTE *left = (const BYTE *)a, *right = (const BYTE *)b;
    for (UINT i = 0; i < sizeof(GUID); i++) if (left[i] != right[i]) return FALSE;
    return TRUE;
}
static ULONG WINAPI counter_addref(Counter *self) { return ++self->refs; }
static ULONG WINAPI counter_release(Counter *self)
{
    ULONG refs = --self->refs;
    if (!refs) { objects--; HeapFree(GetProcessHeap(), 0, self); }
    return refs;
}
static HRESULT WINAPI counter_query(Counter *self, REFIID iid, void **out)
{
    if (!out) return E_POINTER;
    *out = NULL;
    if (!equal(iid, &IID_IUnknown) && !equal(iid, &IID_Counter)) return E_NOINTERFACE;
    *out = self; counter_addref(self); return S_OK;
}
static HRESULT WINAPI counter_add(Counter *self, LONG amount, LONG *out)
{
    if (!out) return E_POINTER;
    *out = self->value += amount;
    return S_OK;
}
static const CounterVtbl counter_vtable = {counter_query, counter_addref, counter_release, counter_add};
static ULONG WINAPI factory_addref(IClassFactory *self) { (void)self; return ++factory_refs; }
static ULONG WINAPI factory_release(IClassFactory *self) { (void)self; return --factory_refs; }
static HRESULT WINAPI factory_query(IClassFactory *self, REFIID iid, void **out)
{
    if (!out) return E_POINTER;
    *out = NULL;
    if (!equal(iid, &IID_IUnknown) && !equal(iid, &IID_IClassFactory)) return E_NOINTERFACE;
    *out = self; factory_addref(self); return S_OK;
}
static HRESULT WINAPI factory_create(IClassFactory *self, IUnknown *outer, REFIID iid, void **out)
{
    (void)self;
    if (!out) return E_POINTER;
    *out = NULL;
    if (outer) return CLASS_E_NOAGGREGATION;
    if (!equal(iid, &IID_IUnknown) && !equal(iid, &IID_Counter)) return E_NOINTERFACE;
    Counter *object = HeapAlloc(GetProcessHeap(), 0, sizeof(*object));
    if (!object) return E_OUTOFMEMORY;
    object->lpVtbl = &counter_vtable; object->refs = 1; object->value = 42;
    objects++; *out = object;
    return S_OK;
}
static HRESULT WINAPI factory_lock(IClassFactory *self, BOOL lock)
{
    (void)self;
    if (lock) locks++; else if (locks) locks--;
    return S_OK;
}
static IClassFactoryVtbl factory_vtable = {factory_query, factory_addref, factory_release, factory_create, factory_lock};
static IClassFactory factory = {&factory_vtable};

__declspec(dllexport) HRESULT WINAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void **out)
{
    if (!out) return E_POINTER;
    *out = NULL;
    if (!attached) return E_UNEXPECTED;
    if (!equal(clsid, &CLSID_Counter)) return CLASS_E_CLASSNOTAVAILABLE;
    return factory_query(&factory, iid, out);
}
__declspec(dllexport) HRESULT WINAPI DllCanUnloadNow(void)
{ return factory_refs || objects || locks ? S_FALSE : S_OK; }
__declspec(dllexport) DWORD WINAPI ReadStats(void)
{ return factory_refs | (objects << 8) | (locks << 16); }
BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void *reserved)
{
    (void)instance; (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) attached = TRUE;
    if (reason == DLL_PROCESS_DETACH) attached = FALSE;
    return TRUE;
}
