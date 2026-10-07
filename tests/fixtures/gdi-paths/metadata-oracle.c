/* Original WineBrowser contributors, MIT. Native path state and LOGPEN oracle. */
#include <windows.h>
#include <stdio.h>
int main(void){HDC dc=CreateCompatibleDC(NULL);POINT p[]={{0,0},{10,10},{20,0},{30,10}};DWORD counts[2];for(int kind=0;kind<2;kind++)for(int groups=0;groups<=2;groups++)for(int n=0;n<3;n++){counts[0]=n;counts[1]=2;SetLastError(777);BOOL ok=kind?PolyPolyline(dc,p,counts,groups):PolyPolygon(dc,p,(INT *)counts,groups);printf("GROUP %d %d %d %d %lu\n",kind,groups,n,ok,GetLastError());}
for(int mode=-1;mode<4;mode++){SetLastError(777);int result=SetPolyFillMode(dc,mode);printf("MODE %d %d %lu %d\n",mode,result,GetLastError(),GetPolyFillMode(dc));}
for(int style=0;style<7;style++)for(int width=-1;width<=2;width++){LOGPEN p={style,{width,123},0xff332211},out={0};SetLastError(777);HPEN pen=CreatePenIndirect(&p);DWORD error=GetLastError();int size=GetObjectW(pen,sizeof(out),&out);printf("PEN %d %d %d %lu %d %u %ld %ld %lu\n",style,width,pen!=NULL,error,size,out.lopnStyle,out.lopnWidth.x,out.lopnWidth.y,out.lopnColor);DeleteObject(pen);}
DeleteDC(dc);return 0;}
