#include <windows.h>
void mainCRTStartup(void) {
    static const char output[]="native Wine base: dynamic DLL verified\r\n";
    DWORD written=0;
    HMODULE dll=LoadLibraryA("helper.dll");
    if(!dll) ExitProcess(1);
    ULONG (WINAPI *checksum)(void)=(void *)GetProcAddress(dll,"NativeChecksum@0");
    if(!checksum || checksum()!=0xcbf43926u) ExitProcess(2);
    if(!FreeLibrary(dll)) ExitProcess(3);
    if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),output,sizeof(output)-1,&written,0) || written!=sizeof(output)-1) ExitProcess(4);
    ExitProcess(0);
}
