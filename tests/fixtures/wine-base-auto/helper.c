#include <windows.h>
ULONG WINAPI RtlComputeCrc32(ULONG crc, const void *bytes, INT count);
__declspec(dllexport) ULONG WINAPI NativeChecksum(void) {
    static const char input[]="123456789";
    return RtlComputeCrc32(0,input,9);
}
