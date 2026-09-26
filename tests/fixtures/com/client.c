#include "counter.h"
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static const WCHAR key_path[] = L"CLSID\\{9a5bf010-1234-4321-8234-102030405060}\\InprocServer32";
static const WCHAR dll_path[] = L"plugins\\counter.dll";
static const WCHAR model[] = L"Both";

void start(void)
{
    HKEY key;
    Counter *object = (Counter *)1, *second;
    IClassFactory *factory;
    IUnknown *unknown;
    LONG value;
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
    CHECK(CoCreateInstance(&CLSID_Counter, NULL, CLSCTX_ALL, &IID_Counter, (void **)&object) == S_OK);
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
