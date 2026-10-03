// SPDX-License-Identifier: MIT
#include <windows.h>
static DWORD attached;
BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void *reserved) {
  (void)instance;(void)reserved;
  if(reason==DLL_PROCESS_ATTACH)attached=1;
  if(reason==DLL_PROCESS_DETACH)attached=0;
  return TRUE;
}
__declspec(dllexport) DWORD __cdecl DelayedAdd(DWORD a,DWORD b){return attached?a+b:0;}
DWORD __cdecl DelayedOrdinal(void){return attached?0xc14:0;}
