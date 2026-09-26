#include "counter.h"
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static const WCHAR key_path[] = L"CLSID\\{9a5bf010-1234-4321-8234-102030405060}\\InprocServer32";
static const WCHAR dll_path[] = L"plugins\\counter.dll";
static const WCHAR model[] = L"Both";

static int same_guid(const GUID *a, const GUID *b)
{
    const BYTE *x = (const BYTE *)a, *y = (const BYTE *)b;
    for (int i = 0; i < 16; i++) if (x[i] != y[i]) return 0;
    return 1;
}

static void check_identifiers(CLSID *resolved)
{
    static const WCHAR text[] = L"{9a5bF010-1234-4321-8234-102030405060}";
    GUID id, null_guid = {0};
    WCHAR formatted[40];
    HKEY key;
    SetLastError(0x1234abcd);
    CHECK(CLSIDFromString(text, &id) == S_OK && same_guid(&id, &CLSID_Counter));
    CHECK(GetLastError() == 0x1234abcd);
    CHECK(IIDFromString(text, &id) == S_OK && same_guid(&id, &CLSID_Counter));
    formatted[39] = 0x1234;
    CHECK(StringFromGUID2(&id, formatted, 39) == 39 && formatted[38] == 0 && formatted[39] == 0x1234);
    CHECK(formatted[2] == 'A' && formatted[5] == 'F');
    CHECK(IIDFromString(formatted, resolved) == S_OK && same_guid(resolved, &id));
    formatted[0] = '!';
    CHECK(StringFromGUID2(&id, formatted, 38) == 0 && formatted[0] == '!');
    CHECK(CLSIDFromString(NULL, &id) == S_OK && same_guid(&id, &null_guid));
    CHECK(IIDFromString(NULL, &id) == S_OK && same_guid(&id, &null_guid));
    CHECK(CLSIDFromString(text, NULL) == E_INVALIDARG);
    CHECK(CLSIDFromString(L"{9a*", &id) == CO_E_CLASSSTRING && id.Data1 == 0x9a && !id.Data2);
    id = CLSID_Counter;
    CHECK(IIDFromString(L"bad", &id) == E_INVALIDARG && same_guid(&id, &CLSID_Counter));
    CHECK(CLSIDFromString(L"WineBrowser.Counter", &id) == CO_E_CLASSSTRING && same_guid(&id, &null_guid));
    CHECK(RegCreateKeyExW(HKEY_CLASSES_ROOT, L"WineBrowser.Counter\\CLSID", 0, NULL, 0, KEY_SET_VALUE, NULL, &key, NULL) == 0);
    CHECK(RegSetValueExW(key, NULL, 0, REG_SZ, (const BYTE *)text, sizeof(text)) == 0);
    CHECK(RegCloseKey(key) == 0);
    CHECK(CLSIDFromString(L"winebrowser.counter", resolved) == S_OK && same_guid(resolved, &CLSID_Counter));
    CHECK(IIDFromString(L"WineBrowser.Counter", resolved) == E_INVALIDARG && same_guid(resolved, &CLSID_Counter));
}

void start(void)
{
    HKEY key;
    Counter *object = (Counter *)1, *second;
    IClassFactory *factory;
    IUnknown *unknown;
    LONG value;
    CLSID resolved;
    check_identifiers(&resolved);
    CHECK(CoCreateInstance(&CLSID_Counter, NULL, CLSCTX_INPROC_SERVER, &IID_Counter,
        (void **)&object) == CO_E_NOTINITIALIZED && !object);
    CHECK(CoInitialize(NULL) == S_OK);
    CHECK(CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) == S_FALSE);
    CHECK(CoInitializeEx(NULL, COINIT_MULTITHREADED) == RPC_E_CHANGED_MODE);
    CHECK(CoCreateInstance(&CLSID_Counter, NULL, CLSCTX_INPROC_SERVER, &IID_Counter,
        (void **)&object) == REGDB_E_CLASSNOTREG && !object);
    CHECK(RegCreateKeyExW(HKEY_CLASSES_ROOT, key_path, 0, NULL, 0, KEY_SET_VALUE, NULL, &key, NULL) == 0);
    CHECK(RegSetValueExW(key, NULL, 0, REG_SZ, (const BYTE *)dll_path, sizeof(dll_path)) == 0);
    CHECK(RegSetValueExW(key, L"ThreadingModel", 0, REG_SZ, (const BYTE *)model, sizeof(model)) == 0);
    CHECK(RegCloseKey(key) == 0);
    CHECK(CoCreateInstance(&resolved, NULL, CLSCTX_ALL, &IID_Counter, (void **)&object) == S_OK);
    CHECK(object->lpVtbl->Add(object, 5, &value) == S_OK && value == 47);
    CHECK(object->lpVtbl->QueryInterface(object, &IID_IUnknown, (void **)&unknown) == S_OK);
    CHECK((void *)unknown == (void *)object && IUnknown_Release(unknown) == 1);
    HMODULE module = GetModuleHandleA("counter.dll");
    CHECK(module != NULL);
    DWORD (WINAPI *stats)(void) = (void *)GetProcAddress(module, "ReadStats");
    CHECK(stats && stats() == 0x100); // CoCreateInstance released its factory.
    CHECK(CoCreateInstance(&CLSID_Counter, NULL, CLSCTX_INPROC_SERVER, &IID_IClassFactory,
        (void **)&second) == E_NOINTERFACE && !second && stats() == 0x100);
    CHECK(CoCreateInstance(&CLSID_Counter, (IUnknown *)object, CLSCTX_INPROC_SERVER, &IID_Counter,
        (void **)&second) == CLASS_E_NOAGGREGATION && !second && stats() == 0x100);
    CoFreeUnusedLibraries();
    CHECK(GetModuleHandleA("counter.dll") == module); // Live object protects its DLL.
    CHECK(CoGetClassObject(&CLSID_Counter, CLSCTX_INPROC_SERVER, NULL, &IID_IClassFactory,
        (void **)&factory) == S_OK);
    CHECK(IClassFactory_LockServer(factory, TRUE) == S_OK);
    CHECK(IClassFactory_CreateInstance(factory, NULL, &IID_Counter, (void **)&second) == S_OK);
    CHECK(second->lpVtbl->Add(second, -2, &value) == S_OK && value == 40);
    CHECK(second->lpVtbl->Release(second) == 0);
    CHECK(object->lpVtbl->Release(object) == 0);
    CHECK(stats() == 0x10001);
    CoFreeUnusedLibraries();
    CHECK(GetModuleHandleA("counter.dll") == module);
    CHECK(IClassFactory_LockServer(factory, FALSE) == S_OK);
    CHECK(IClassFactory_Release(factory) == 0 && stats() == 0);
    CoFreeUnusedLibraries();
    CHECK(GetModuleHandleA("counter.dll") == NULL);
    CHECK(CoCreateInstance(&CLSID_Counter, NULL, CLSCTX_INPROC_SERVER, &IID_Counter,
        (void **)&object) == S_OK);
    CHECK(object->lpVtbl->Add(object, 0, &value) == S_OK && value == 42);
    CHECK(object->lpVtbl->Release(object) == 0);
    CoUninitialize(); // Balances S_FALSE; still initialized.
    CHECK(CoGetClassObject(&CLSID_Counter, CLSCTX_INPROC_SERVER, NULL, &IID_IClassFactory,
        (void **)&factory) == S_OK);
    CHECK(IClassFactory_Release(factory) == 0);
    CoUninitialize();
    CHECK(GetModuleHandleA("counter.dll") == NULL);
    CHECK(CoCreateInstance(&CLSID_Counter, NULL, CLSCTX_INPROC_SERVER, &IID_Counter,
        (void **)&object) == CO_E_NOTINITIALIZED && !object);
    CHECK(CoInitializeEx(NULL, COINIT_MULTITHREADED) == S_OK);
    CHECK(CoCreateInstance(&CLSID_Counter, NULL, CLSCTX_INPROC_SERVER, &IID_Counter,
        (void **)&object) == S_OK);
    CHECK(object->lpVtbl->Release(object) == 0);
    CoUninitialize();
    ExitProcess(0);
}
