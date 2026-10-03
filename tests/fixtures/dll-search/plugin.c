// SPDX-License-Identifier: MIT
#include <windows.h>
__declspec(dllimport) int __cdecl identify(void);
static int attached;
__declspec(dllexport) int __cdecl invoke(void) { return attached+identify(); }
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,LPVOID reserved) {
  (void)instance;(void)reserved;
  if(reason==DLL_PROCESS_ATTACH) attached=identify();
  return TRUE;
}
