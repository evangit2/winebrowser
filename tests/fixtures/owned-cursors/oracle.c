/* Original WineBrowser contributors, MIT. Native icon/cursor ownership evidence. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
static int first=1;
static void emit(const char *name,UINT result,DWORD error,HICON handle){
 ICONINFO info={0};SetLastError(888);BOOL valid=GetIconInfo(handle,&info);DWORD infoerror=GetLastError();
 printf("%s{\"name\":\"%s\",\"result\":%u,\"error\":%lu,\"valid\":%u,\"infoError\":%lu,\"icon\":%u,\"hotX\":%lu,\"hotY\":%lu,\"color\":%u}",first?"":",\n",name,result,error,valid,infoerror,info.fIcon,info.xHotspot,info.yHotspot,info.hbmColor!=NULL);first=0;
 if(valid){DeleteObject(info.hbmMask);if(info.hbmColor)DeleteObject(info.hbmColor);}
}
static HICON make(BOOL icon,DWORD hx,DWORD hy,int mono){
 BYTE maskbits[]={0x80,0,0x40,0,0xc0,0,0x40,0};HBITMAP mask=CreateBitmap(2,mono?4:2,1,1,maskbits),color=NULL;HDC dc=GetDC(NULL);
 if(!mono){BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=2;bmi.bmiHeader.biHeight=-2;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;DWORD *bits;color=CreateDIBSection(dc,&bmi,0,(void **)&bits,NULL,0);DWORD values[]={0x80102030,0x00405060,0x80708090,0xffa0b0c0};for(int i=0;i<4;i++)bits[i]=values[i];}
 ICONINFO info={icon,hx,hy,mask,color};SetLastError(777);HICON made=CreateIconIndirect(&info);DWORD error=GetLastError();char name[80];sprintf(name,"create-%u-%lu-%lu-%u",icon,hx,hy,mono);emit(name,made!=NULL,error,made);
 DeleteObject(mask);if(color)DeleteObject(color);ReleaseDC(NULL,dc);return made;
}
int main(void){
 puts("[");HICON color=make(FALSE,1,0,0),mono=make(FALSE,0,1,1),outside=make(FALSE,19,31,0),icon=make(TRUE,19,31,0);
 SetLastError(777);HICON copy=CopyIcon(color);DWORD error=GetLastError();emit("copy-cursor",copy!=NULL,error,copy);
 SetLastError(777);HICON scaled=CopyImage(color,IMAGE_CURSOR,4,4,0);error=GetLastError();emit("scale-cursor",scaled!=NULL,error,scaled);
 SetLastError(777);HICON shared=CopyImage(color,IMAGE_CURSOR,2,2,LR_COPYRETURNORG);error=GetLastError();emit("same-copy-return",shared==color,error,shared);
 HCURSOR system=LoadCursorW(NULL,IDC_ARROW);SetLastError(777);BOOL ok=DestroyCursor(system);error=GetLastError();emit("destroy-shared-cursor",ok,error,system);
 HICON systemIcon=LoadIconW(NULL,IDI_APPLICATION);SetLastError(777);ok=DestroyIcon(systemIcon);error=GetLastError();emit("destroy-shared-icon",ok,error,systemIcon);
 SetLastError(777);ok=DestroyCursor(icon);error=GetLastError();emit("destroy-cursor-of-icon",ok,error,icon);
 SetLastError(777);ok=DestroyIcon(mono);error=GetLastError();emit("destroy-icon-of-cursor",ok,error,mono);
 SetCursor(color);SetLastError(777);ok=DestroyCursor(color);error=GetLastError();emit("destroy-active-cursor",ok,error,color);
 SetLastError(777);emit("get-destroyed-active",GetCursor()==color,GetLastError(),color);SetCursor(NULL);
 SetLastError(777);ok=DestroyCursor(color);error=GetLastError();emit("destroy-twice",ok,error,color);
 SetLastError(777);ok=DestroyCursor(NULL);error=GetLastError();emit("destroy-null",ok,error,NULL);
 DestroyCursor(copy);DestroyCursor(scaled);DestroyCursor(outside);puts("\n]");return 0;
}
