typedef unsigned long DWORD;
typedef int BOOL;
typedef int(__attribute__((cdecl)) *Callback)(int);

static volatile int attached;

static int __attribute__((cdecl)) core_sum(int left, int right) {
  return left + right;
}

// A PE32 absolute pointer exercises HIGHLOW relocation when the loader chooses
// a base other than the DLL's preferred base.
static int(__attribute__((cdecl)) *volatile relocation_anchor)(int, int) = core_sum;

int __attribute__((cdecl)) sum(int left, int right) {
  if (!attached) return -100;
  return relocation_anchor(left, right);
}

int __attribute__((cdecl)) OrdinalOnly(void) {
  return attached ? 42 : -1;
}

int __attribute__((cdecl)) CallCallback(Callback callback, int value) {
  if (!attached || !callback) return -2;
  return callback(value);
}

BOOL __attribute__((stdcall)) DllMain(void *module, DWORD reason, void *reserved) {
  (void)module;
  (void)reserved;
  if (reason == 1) attached = 1; // DLL_PROCESS_ATTACH
  if (reason == 0) attached = 0; // DLL_PROCESS_DETACH
  return 1;
}
