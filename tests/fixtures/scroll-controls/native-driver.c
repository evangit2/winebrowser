/* Original WineBrowser contributors, MIT. Desktop SDK GUI acceptance driver. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
int main(void) {
    STARTUPINFOW startup={0};PROCESS_INFORMATION process={0};startup.cb=sizeof(startup);
    WCHAR command[]=L"tests/fixtures/scroll-controls/scroll-controls.exe";
    if(!CreateProcessW(NULL,command,NULL,NULL,TRUE,0,NULL,NULL,&startup,&process))return 1;
    HWND window=NULL;for(int i=0;i<90&&!window;i++){Sleep(50);window=FindWindowW(L"NativeScrollbarControls",L"Native scrollbars - Normal");}
    if(!window){TerminateProcess(process.hProcess,2);return 2;}
    for(int i=0;i<9;i++){
        SendMessageW(window,WM_COMMAND,101+i,0);UpdateWindow(window);
        if(WaitForSingleObject(process.hProcess,0)==WAIT_OBJECT_0){DWORD result;GetExitCodeProcess(process.hProcess,&result);printf("premature %lu\n",result);return 3;}
    }
    WCHAR label[80];
    for(int id=206;id<=209;id++){
        SendMessageW(window,WM_COMMAND,107,0);
        HWND control=GetDlgItem(window,id);if(!control)return 6;
        LPARAM point=id>=208?MAKELPARAM(9,171):MAKELPARAM(171,9);
        PostMessageW(control,WM_LBUTTONDOWN,MK_LBUTTON,point);
        Sleep(50);
        PostMessageW(control,WM_LBUTTONUP,0,point);
        Sleep(50);
        GetWindowTextW(GetDlgItem(window,305),label,80);
        if(lstrcmpW(label,L"Aligned position: 21"))return 7;
        SendMessageW(control,WM_KEYDOWN,id>=208?VK_DOWN:VK_RIGHT,1);
        GetWindowTextW(GetDlgItem(window,305),label,80);
        if(lstrcmpW(label,L"Aligned position: 22"))return 8;
    }
    PostMessageW(window,WM_CLOSE,0,0);
    if(WaitForSingleObject(process.hProcess,10000)!=WAIT_OBJECT_0){TerminateProcess(process.hProcess,4);return 4;}
    DWORD result=999;GetExitCodeProcess(process.hProcess,&result);CloseHandle(process.hThread);CloseHandle(process.hProcess);
    printf("Native SDK client nine stages and four aligned mouse/keyboard controls, exit %lu\n",result);return result?5:0;
}
