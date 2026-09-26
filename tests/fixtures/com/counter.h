#define COBJMACROS
#include <windows.h>
#include <objbase.h>

static const GUID CLSID_Counter = {0x9a5bf010,0x1234,0x4321,{0x82,0x34,0x10,0x20,0x30,0x40,0x50,0x60}};
static const GUID IID_Counter = {0x9a5bf011,0x1234,0x4321,{0x82,0x34,0x10,0x20,0x30,0x40,0x50,0x60}};
typedef struct Counter Counter;
typedef struct CounterVtbl {
    HRESULT (WINAPI *QueryInterface)(Counter *, REFIID, void **);
    ULONG (WINAPI *AddRef)(Counter *);
    ULONG (WINAPI *Release)(Counter *);
    HRESULT (WINAPI *Add)(Counter *, LONG, LONG *);
} CounterVtbl;
struct Counter { const CounterVtbl *lpVtbl; ULONG refs; LONG value; };
