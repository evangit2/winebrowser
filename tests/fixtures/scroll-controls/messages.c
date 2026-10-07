/* Original WineBrowser contributors, MIT. Direct SBM and getter validation. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
int main(void){
 HWND parent=CreateWindowExW(0,L"STATIC",L"",WS_POPUP,10,20,200,120,NULL,NULL,GetModuleHandleW(NULL),NULL);
 HWND w=CreateWindowExW(0,L"SCROLLBAR",L"",WS_CHILD|SBS_HORZ,0,0,180,17,parent,NULL,GetModuleHandleW(NULL),NULL);if(!w)return 2;
 puts("[");int first=1;
 for(int size=20;size<=32;size+=4)for(unsigned mask=0;mask<=33;mask++){
  SCROLLINFO in={28,23,10,40,8,20,0};SetScrollInfo(w,SB_CTL,&in,FALSE);
  SCROLLINFO out={size,mask,1,2,3,4,5};SetLastError(777);LRESULT result=SendMessageW(w,SBM_GETSCROLLINFO,0,(LPARAM)&out);DWORD error=GetLastError();
  printf("%s{\"kind\":\"get\",\"size\":%d,\"mask\":%u,\"result\":%ld,\"error\":%lu,\"out\":[%u,%u,%d,%d,%u,%d,%d]}",first?"":",\n",size,mask,result,error,out.cbSize,out.fMask,out.nMin,out.nMax,out.nPage,out.nPos,out.nTrackPos);first=0;
 }
 const UINT messages[]={SBM_SETPOS,SBM_SETRANGE,SBM_SETRANGEREDRAW,SBM_ENABLE_ARROWS,SBM_ENABLE_ARROWS};const WPARAM wp[]={31,-20,-10,3,3};const LPARAM lp[]={0,60,50,0,0};
 for(unsigned i=0;i<5;i++){
  SCROLLINFO in={28,23,10,40,8,20,0};SetScrollInfo(w,SB_CTL,&in,FALSE);SetLastError(777);LRESULT result=SendMessageW(w,messages[i],wp[i],lp[i]);DWORD error=GetLastError();
  SCROLLINFO out={28,23,1,2,3,4,5};GetScrollInfo(w,SB_CTL,&out);
  printf(",\n{\"kind\":\"message\",\"message\":%u,\"wp\":%ld,\"lp\":%ld,\"result\":%ld,\"error\":%lu,\"out\":[%u,%u,%d,%d,%u,%d,%d]}",messages[i],(LONG)wp[i],(LONG)lp[i],result,error,out.cbSize,out.fMask,out.nMin,out.nMax,out.nPage,out.nPos,out.nTrackPos);
 }
 puts("]");DestroyWindow(w);DestroyWindow(parent);return 0;
}
