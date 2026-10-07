/* Original WineBrowser contributors, MIT. Classic native scrollbar geometry/pixels. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
static int first=1;
static void capture(HWND parent,int vertical,int length,int thickness,int stage){
 HWND w=CreateWindowExW(0,L"SCROLLBAR",L"",WS_CHILD|WS_VISIBLE|(vertical?SBS_VERT:0),30,30,vertical?thickness:length,vertical?length:thickness,parent,NULL,GetModuleHandleW(NULL),NULL);
 if(!w){ExitProcess(2);}
 SCROLLINFO info={28,SIF_ALL,10,40,8,20,0};
 if(stage==0){info.nMin=info.nMax=info.nPos=0;info.nPage=0;}
 if(stage==2)info.nPos=10;
 if(stage==3)info.nPos=33;
 if(stage==4)info.nPage=0;
 if(stage==5)info.nPage=100;
 if(stage==6){info.nMin=-2147483647-1;info.nMax=2147483647;info.nPage=0;info.nPos=0;}
 if(stage==11){info.nMin=-20;info.nMax=200000;info.nPage=64;info.nPos=80000;}
 if(stage==7){info.nMin=40;info.nMax=10;info.nPage=8;info.nPos=20;}
 SetScrollInfo(w,SB_CTL,&info,TRUE);
 if(stage>=8&&stage<=10)SendMessageW(w,SBM_ENABLE_ARROWS,stage-7,0);
 RedrawWindow(w,NULL,NULL,RDW_INVALIDATE|RDW_UPDATENOW|RDW_ERASE);
 SCROLLBARINFO b={0};b.cbSize=sizeof(b);GetScrollBarInfo(w,OBJID_CLIENT,&b);
 SCROLLINFO out={28,SIF_ALL,0,0,0,0,0};GetScrollInfo(w,SB_CTL,&out);
 HDC dc=GetDC(w);int width=vertical?thickness:length,height=vertical?length:thickness;
 printf("%s{\"vertical\":%d,\"length\":%d,\"thickness\":%d,\"stage\":%d,\"state\":[%d,%d,%u,%d],\"arrow\":%d,\"thumb\":[%d,%d],\"states\":[%lu,%lu,%lu,%lu,%lu,%lu],\"runs\":[",first?"":",\n",vertical,length,thickness,stage,out.nMin,out.nMax,out.nPage,out.nPos,b.dxyLineButton,b.xyThumbTop,b.xyThumbBottom,b.rgstate[0],b.rgstate[1],b.rgstate[2],b.rgstate[3],b.rgstate[4],b.rgstate[5]);first=0;int rf=1;
 for(int y=0;y<height;y++)for(int x=0;x<width;){COLORREF color=GetPixel(dc,x,y);int end=x+1;while(end<width&&GetPixel(dc,end,y)==color)end++;printf("%s[%d,%d,%d,%lu]",rf?"":",",x,y,end-x,color);rf=0;x=end;}
 puts("]}");ReleaseDC(w,dc);DestroyWindow(w);
}
int main(void){
 int indices[]={COLOR_SCROLLBAR,COLOR_WINDOW,COLOR_WINDOWFRAME,COLOR_WINDOWTEXT,COLOR_BTNFACE,COLOR_BTNSHADOW,COLOR_BTNTEXT,COLOR_BTNHIGHLIGHT,COLOR_3DDKSHADOW,COLOR_3DLIGHT};
 COLORREF colors[]={0xc0c0c0,0xffffff,0,0,0xc0c0c0,0x808080,0,0xffffff,0x404040,0xe3e3e3},saved[10];for(int i=0;i<10;i++)saved[i]=GetSysColor(indices[i]);if(!SetSysColors(10,indices,colors))return 2;
 WNDCLASSW cls={0};cls.lpfnWndProc=DefWindowProcW;cls.hInstance=GetModuleHandleW(NULL);cls.lpszClassName=L"ScrollGeometryParent";if(!RegisterClassW(&cls))return 1;
 HWND parent=CreateWindowExW(0,cls.lpszClassName,L"geometry",WS_POPUP|WS_VISIBLE,10,20,400,400,NULL,NULL,cls.hInstance,NULL);
 int lengths[]={180,40,33,17,8},thicknesses[]={17,25};puts("[");
 for(int v=0;v<2;v++)for(unsigned l=0;l<5;l++)for(unsigned t=0;t<2;t++)for(int stage=0;stage<12;stage++)capture(parent,v,lengths[l],thicknesses[t],stage);
 puts("]");DestroyWindow(parent);SetSysColors(10,indices,saved);return 0;
}
