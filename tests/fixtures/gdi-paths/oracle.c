/* Original WineBrowser contributors, MIT. Native polygon and line SDK oracle. */
#include <windows.h>
#include <stdio.h>
static int first=1;
static const POINT star[]={{2,2},{16,29},{29,2},{2,20},{29,20}};
static const POINT rings[]={{2,2},{29,2},{29,29},{2,29},{8,8},{23,8},{23,23},{8,23}};
static const POINT reversed[]={{2,2},{29,2},{29,29},{2,29},{8,23},{23,23},{23,8},{8,8}};
static const POINT lines[]={{2,2},{16,16},{29,2},{2,29},{16,16},{29,29}};
static void emit(HDC dc,const char *name,const POINT *points,const DWORD *counts,int groups,int mode,int kind,int clip,int outlined){
 SelectClipRgn(dc,NULL);RECT box={0,0,32,32};HBRUSH back=CreateSolidBrush(RGB(64,96,128));FillRect(dc,&box,back);DeleteObject(back);
 SetPolyFillMode(dc,mode);if(clip){HRGN a=CreateRectRgn(3,5,28,27),b=CreateRectRgn(12,12,20,20);CombineRgn(a,a,b,RGN_DIFF);SelectClipRgn(dc,a);DeleteObject(a);DeleteObject(b);}
 HGDIOBJ old=SelectObject(dc,(kind==2||outlined)?GetStockObject(WHITE_PEN):GetStockObject(NULL_PEN));POINT original={0};MoveToEx(dc,7,9,&original);
 SetLastError(777);BOOL ok=kind==2?PolyPolyline(dc,points,counts,groups):kind==1?PolyPolygon(dc,points,(const INT *)counts,groups):Polygon(dc,points,counts[0]);DWORD error=GetLastError();POINT current;GetCurrentPositionEx(dc,&current);SelectClipRgn(dc,NULL);SelectObject(dc,old);
 int total=0;for(int i=0;i<groups;i++)total+=(int)counts[i];
 printf("%s{\"name\":\"%s\",\"kind\":%d,\"mode\":%d,\"clip\":%d,\"outlined\":%d,\"counts\":[",first?"":",\n",name,kind,mode,clip,outlined);first=0;for(int i=0;i<groups;i++)printf("%s%lu",i?",":"",counts[i]);printf("],\"points\":[");for(int i=0;i<total;i++)printf("%s[%ld,%ld]",i?",":"",points[i].x,points[i].y);
 printf("],\"result\":%d,\"error\":%lu,\"current\":[%ld,%ld],\"pixels\":[",ok,error,current.x,current.y);for(int y=0;y<32;y++)for(int x=0;x<32;x++)printf("%s%lu",x||y?",":"",GetPixel(dc,x,y));puts("]}");
}
int main(void){HDC screen=GetDC(NULL),dc=CreateCompatibleDC(screen);BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=32;bmi.bmiHeader.biHeight=-32;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;void *bits;HBITMAP bitmap=CreateDIBSection(screen,&bmi,0,&bits,NULL,0);HGDIOBJ old=SelectObject(dc,bitmap);HBRUSH fill=CreateSolidBrush(RGB(240,145,30));HGDIOBJ oldbrush=SelectObject(dc,fill);
 puts("[");DWORD one[]={5},two[]={4,4},linecounts[]={3,3};emit(dc,"alternate",star,one,1,ALTERNATE,0,0,0);emit(dc,"winding",star,one,1,WINDING,0,0,0);emit(dc,"contours-alternate",rings,two,2,ALTERNATE,1,0,0);emit(dc,"contours-winding",rings,two,2,WINDING,1,0,0);emit(dc,"opposite-winding",reversed,two,2,WINDING,1,0,0);emit(dc,"lines",lines,linecounts,2,ALTERNATE,2,0,0);emit(dc,"clipped",star,one,1,WINDING,0,1,0);emit(dc,"lines-clipped",lines,linecounts,2,ALTERNATE,2,1,0);
 DWORD seed=91;for(int sample=0;sample<24;sample++){POINT p[9];DWORD count[]={3+(DWORD)sample%7};for(unsigned i=0;i<count[0];i++){seed=seed*1664525+1013904223;p[i].x=(int)(seed%48)-8;seed=seed*1664525+1013904223;p[i].y=(int)(seed%48)-8;}char name[40];for(int mode=1;mode<=2;mode++){sprintf(name,"random-%d-%d",sample,mode);emit(dc,name,p,count,1,mode,0,sample%3==0,0);}}
 const POINT ends[]={{29,22},{22,29},{9,29},{2,22},{2,9},{9,2},{22,2},{29,9},{40,25},{25,40},{-8,25},{25,-8}};DWORD pair[]={2};for(unsigned i=0;i<sizeof(ends)/sizeof(ends[0]);i++)for(int reverse=0;reverse<2;reverse++)for(int clip=0;clip<2;clip++){POINT p[2]={{16,16},ends[i]};if(reverse){POINT tmp=p[0];p[0]=p[1];p[1]=tmp;}char name[40];sprintf(name,"line-%u-%d-%d",i,reverse,clip);emit(dc,name,p,pair,1,ALTERNATE,2,clip,0);}
 emit(dc,"outlined-star",star,one,1,WINDING,0,0,1);emit(dc,"outlined-rings",rings,two,2,ALTERNATE,1,0,1);
 POINT pairpoints[]={{3,3},{25,20}};for(int n=0;n<=2;n++)for(int kind=0;kind<=1;kind++){DWORD count[]={(DWORD)n};char name[40];sprintf(name,"small-%d-%d",kind,n);emit(dc,name,pairpoints,count,1,ALTERNATE,kind,0,1);}
 puts("]");SelectObject(dc,oldbrush);DeleteObject(fill);SelectObject(dc,old);DeleteObject(bitmap);DeleteDC(dc);ReleaseDC(NULL,screen);return 0;}
