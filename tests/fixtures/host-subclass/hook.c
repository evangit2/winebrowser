/* Original MIT Windows DLL, using real USER32 procedure forwarding. */
#define HOOK_BUILD
#include "hook.h"
static LRESULT CALLBACK hook(HWND window,UINT message,WPARAM wp,LPARAM lp) {
  HOOK *context=(HOOK*)GetPropA(window,"NativeHookContext");CHECK(context);
  if(message==HOOK_MESSAGE)return 0x77000000|wp;
  if(message==WM_SETTEXT) {
    context->texts++;
    const char *text=(const char*)lp;
    if(!context->wide && text && text[0]=='r' && text[1]=='e' && text[2]=='j') {
      SetWindowTextA(context->root,"Text vetoed");return 0;
    }
  }
  if(message==WM_GETDLGCODE) {
    LRESULT code=context->wide?CallWindowProcW(context->previous,window,message,wp,lp):CallWindowProcA(context->previous,window,message,wp,lp);
    return code|DLGC_WANTTAB;
  }
  if(message==WM_KEYDOWN && (wp==VK_F2 || wp==VK_TAB)) {
    context->keys++;SetWindowTextA(context->root,wp==VK_TAB?"Tab owned by subclass":"Subclass keyboard");return 0;
  }
  if(message==BM_CLICK) {
    context->clicks++;
    if(context->veto){SetWindowTextA(context->root,"Click vetoed");return 0;}
  }
  if(message==WM_NCDESTROY)context->destroyed++;
  return context->wide?CallWindowProcW(context->previous,window,message,wp,lp):CallWindowProcA(context->previous,window,message,wp,lp);
}
__declspec(dllexport) BOOL WINAPI InstallHook(HWND window,HOOK *context) {
  context->previous=(WNDPROC)(context->wide?GetWindowLongW(window,GWL_WNDPROC):GetWindowLongA(window,GWL_WNDPROC));
  CHECK(context->previous);
  CHECK(SetPropA(window,"NativeHookContext",context));
  WNDPROC previous=(WNDPROC)(context->wide?SetWindowLongW(window,GWL_WNDPROC,(LONG)hook):SetWindowLongA(window,GWL_WNDPROC,(LONG)hook));
  CHECK(previous==context->previous);return TRUE;
}
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,LPVOID reserved) {(void)instance;(void)reason;(void)reserved;return TRUE;}
