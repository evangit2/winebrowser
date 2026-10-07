/* Original WineBrowser contributors, MIT. Desktop Wine geometry oracle. */
#include <windows.h>
#include <stdio.h>
static int first=1;
static void emit(const char *kind,int *args,int count,HRGN region) {
    printf("%s{\"kind\":\"%s\",\"args\":[",first ? "" : ",\n",kind); first=0;
    for(int i=0;i<count;i++)printf("%s%d",i?",":"",args[i]);
    printf("],\"rects\":[");
    DWORD size=GetRegionData(region,0,NULL);
    if (!region || !size) ExitProcess(2);
    RGNDATA *data=HeapAlloc(GetProcessHeap(),0,size);
    if(!data || GetRegionData(region,size,data)!=size) ExitProcess(3);
    RECT *rects=(RECT *)data->Buffer;
    for(DWORD i=0;i<data->rdh.nCount;i++)printf("%s[%ld,%ld,%ld,%ld]",i?",":"",rects[i].left,rects[i].top,rects[i].right,rects[i].bottom);
    printf("]}"); HeapFree(GetProcessHeap(),0,data); DeleteObject(region);
}
static void polygon(POINT *p,int count,int mode) {
    int args[130]; args[0]=mode; args[1]=count;
    for(int i=0;i<count;i++) { args[2+i*2]=p[i].x; args[3+i*2]=p[i].y; }
    emit("polygon",args,2+count*2,CreatePolygonRgn(p,count,mode));
}
int main(void) {
    puts("[");
    for(int w=2;w<=24;w++)for(int h=2;h<=24;h+=3) {
        int args[]={-3,2,w-3,h+2}; emit("ellipse",args,4,CreateEllipticRgn(args[0],args[1],args[2],args[3]));
    }
    int rounds[][6]={{0,0,20,16,8,6},{20,16,0,0,-8,-6},{-5,-4,15,17,100,100},{0,0,20,16,0,0},{0,0,20,16,1,8},{5,5,5,5,0,0},{5,5,5,10,0,0}};
    for(unsigned i=0;i<sizeof(rounds)/sizeof(rounds[0]);i++) {int *a=rounds[i];emit("round",a,6,CreateRoundRectRgn(a[0],a[1],a[2],a[3],a[4],a[5]));}
    POINT triangle[]={{0,0},{10,3},{0,6}},star[]={{0,0},{4,6},{8,0},{0,4},{8,4}};
    polygon(triangle,3,ALTERNATE);polygon(star,5,ALTERNATE);polygon(star,5,WINDING);
    DWORD seed=19;
    for(int sample=0;sample<40;sample++) {
        POINT points[9]; int count=3+sample%7;
        for(int i=0;i<count;i++){seed=seed*1664525+1013904223;points[i].x=(int)(seed%25)-12;seed=seed*1664525+1013904223;points[i].y=(int)(seed%25)-12;}
        polygon(points,count,ALTERNATE);polygon(points,count,WINDING);
    }
    POINT nesting[]={{0,0},{12,0},{12,12},{0,12},{3,3},{9,3},{9,9},{3,9}};INT counts[]={4,4};
    for(int mode=1;mode<=2;mode++) {
        int args[20]={mode,2,4,4};for(int i=0;i<8;i++){args[4+i*2]=nesting[i].x;args[5+i*2]=nesting[i].y;}
        emit("polypolygon",args,20,CreatePolyPolygonRgn(nesting,counts,2,mode));
        POINT tmp=nesting[4];nesting[4]=nesting[7];nesting[7]=tmp;tmp=nesting[5];nesting[5]=nesting[6];nesting[6]=tmp;
        for(int i=0;i<8;i++){args[4+i*2]=nesting[i].x;args[5+i*2]=nesting[i].y;}
        emit("polypolygon",args,20,CreatePolyPolygonRgn(nesting,counts,2,mode));
    }
    POINT gui_star[]={{80,110},{220,250},{360,110},{80,200},{360,200}};
    polygon(gui_star,5,ALTERNATE);polygon(gui_star,5,WINDING);
    int gui_round[]={60,105,420,265,80,80};emit("round",gui_round,6,CreateRoundRectRgn(60,105,420,265,80,80));
    int gui_ellipse[]={100,105,380,265};emit("ellipse",gui_ellipse,4,CreateEllipticRgn(100,105,380,265));
    POINT gui_hole[]={{60,105},{420,105},{420,265},{60,265},{145,140},{335,140},{335,230},{145,230}};
    int gui_args[20]={ALTERNATE,2,4,4};for(int i=0;i<8;i++){gui_args[4+i*2]=gui_hole[i].x;gui_args[5+i*2]=gui_hole[i].y;}
    emit("polypolygon",gui_args,20,CreatePolyPolygonRgn(gui_hole,counts,2,ALTERNATE));
    polygon(star,5,0);polygon(star,5,3);polygon(star,5,99);
    polygon(triangle,0,ALTERNATE);polygon(triangle,1,ALTERNATE);polygon(triangle,2,ALTERNATE);
    puts("\n]");return 0;
}
