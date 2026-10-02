#include <windows.h>
/* MinGW's import library gives the real Wine NTDLL body to the browser JIT. */
ULONG WINAPI RtlComputeCrc32(ULONG crc, const void *bytes, INT count);
void mainCRTStartup(void) {
    static const char input[]="123456789";
    static const char output[]="native Wine base: CRC32 verified\r\n";
    DWORD written=0;
    if(RtlComputeCrc32(0,input,9)!=0xcbf43926u) ExitProcess(1);
    if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),output,sizeof(output)-1,&written,0) || written!=sizeof(output)-1) ExitProcess(2);
    ExitProcess(0);
}
