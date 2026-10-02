#include <windows.h>
void mainCRTStartup(void) {
    static const char output[]="native Wine base: dynamic DLL verified\r\n";
    DWORD written=0;
    HMODULE dll=LoadLibraryA("helper.dll");
    if(!dll) ExitProcess(1);
    ULONG (WINAPI *checksum)(void)=(void *)GetProcAddress(dll,"NativeChecksum@0");
    if(!checksum || checksum()!=0xcbf43926u) ExitProcess(2);
#ifdef VERIFY_NATIVE_CRT
    HMODULE crt=LoadLibraryA("msvcrt.dll");
    if(!crt) ExitProcess(5);
    unsigned long (__cdecl *parse)(const char *,char **,int)=(void *)GetProcAddress(crt,"strtoul");
    if(!parse || parse("cbf43926",0,16)!=0xcbf43926u) ExitProcess(6);
#endif
    if(!FreeLibrary(dll)) ExitProcess(3);
    if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),output,sizeof(output)-1,&written,0) || written!=sizeof(output)-1) ExitProcess(4);
    ExitProcess(0);
}
