// SPDX-License-Identifier: MIT
// The executable imports only Kernel32; the supplied plugin needs native C++.
#include <windows.h>
void _start(void) {
  for(int attempt=0;attempt<2;attempt++) {
    HMODULE module=LoadLibraryA("plugins\\cpp-client.dll");if(!module)ExitProcess(30);
    int (WINAPI *run)(void)=(int (WINAPI *)(void))GetProcAddress(module,"RunCppRuntimeChecks");
    if(!run||run()!=0xc14)ExitProcess(31);
    if(!FreeLibrary(module))ExitProcess(32);
    if(GetModuleHandleA("plugins\\cpp-client.dll"))ExitProcess(33);
    if(GetModuleHandleA("msvcp140_1.dll"))ExitProcess(34);
  }
  const char message[]="CPP PLUGIN RELOAD PASS\n";DWORD written;
  WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),message,sizeof(message)-1,&written,0);
  ExitProcess(0);
}
