// SPDX-License-Identifier: MIT
#include <windows.h>
__declspec(dllexport) int __cdecl identify(void) { return IDENTITY; }
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,LPVOID reserved) {
  (void)instance;(void)reason;(void)reserved;return TRUE;
}
