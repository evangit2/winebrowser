/* Minimal Windows entry glue; the Khronos demo and embedded shaders are unchanged. */
#include <windows.h>
int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int);
void mainCRTStartup(void) {
    ExitProcess(WinMain(GetModuleHandleA(NULL), NULL, GetCommandLineA(), SW_SHOWDEFAULT));
}

/* Legacy msvcrt exports double sqrt; preserve the standard float conversion. */
#include <math.h>
float sqrtf(float value) { return (float)sqrt(value); }
