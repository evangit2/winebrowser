#include <windows.h>
#include <stdlib.h>
#include <string.h>
__declspec(dllexport) ULONG WINAPI NativeChecksum(void) {
    static const char input[]="123456789";
    if(strlen(input)!=9) return 0;
    return strtoul("cbf43926",0,16);
}
