/* Original MIT resource DLL with a real native process-attach entry. */
#include <windows.h>
static unsigned attached;
__declspec(dllexport) unsigned WINAPI WasAttached(void){return attached;}
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,void *reserved){
  (void)instance;(void)reserved;if(reason==DLL_PROCESS_ATTACH)attached=1;return TRUE;
}
