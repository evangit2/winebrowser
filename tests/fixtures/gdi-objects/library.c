/* Original MIT native font library. Calls retain a frame to exercise stdcall. */
#include <windows.h>
__declspec(dllexport) HFONT WINAPI FontA(const LOGFONTA *font) {
  HFONT result=CreateFontIndirectA(font);
  SetLastError(result?0:87);
  return result;
}
__declspec(dllexport) HFONT WINAPI FontW(const LOGFONTW *font) {
  HFONT result=CreateFontIndirectW(font);
  SetLastError(result?0:87);
  return result;
}
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,void *reserved) {
  (void)instance;(void)reason;(void)reserved;return TRUE;
}
