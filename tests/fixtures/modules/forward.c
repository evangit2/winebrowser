typedef unsigned long DWORD;
typedef int BOOL;

static volatile int attached;

BOOL __attribute__((stdcall)) DllMain(void *module, DWORD reason, void *reserved) {
  (void)module;
  (void)reserved;
  if (reason == 1) attached = 1;
  if (reason == 0) attached = 0;
  return 1;
}

// Keep a small code section and attached state while ForwardSum itself remains
// a real PE export forwarder defined in forward.def.
int __attribute__((cdecl)) ForwardModuleAttached(void) { return attached; }
