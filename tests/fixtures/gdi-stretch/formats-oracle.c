/* Original WineBrowser contributors, MIT. Native StretchDIBits source format oracle. */
#include <windows.h>
#include <stdio.h>
int main(void){HDC dc=CreateCompatibleDC(NULL);BITMAPINFO target={0};target.bmiHeader.biSize=40;target.bmiHeader.biWidth=16;target.bmiHeader.biHeight=-16;target.bmiHeader.biPlanes=1;target.bmiHeader.biBitCount=32;DWORD *dst;HBITMAP bitmap=CreateDIBSection(dc,&target,0,(void **)&dst,NULL,0);HGDIOBJ old=SelectObject(dc,bitmap);int first=1;puts("[");
 int depths[]={1,4,8,16,16,24,32,32,8};
 for(unsigned sample=0;sample<sizeof(depths)/sizeof(depths[0]);sample++){BYTE bytes[36]={0},info[1064]={0};BITMAPINFO *bmi=(BITMAPINFO *)info;bmi->bmiHeader.biSize=40;bmi->bmiHeader.biWidth=3;bmi->bmiHeader.biHeight=-3;bmi->bmiHeader.biPlanes=1;bmi->bmiHeader.biBitCount=depths[sample];int depth=depths[sample],usage=sample==8?DIB_PAL_COLORS:DIB_RGB_COLORS,count=depth==1?2:4,infoSize=40,stride=((3*depth+31)/32)*4;
 if(depth<=8){bmi->bmiHeader.biClrUsed=count;infoSize+=count*(usage?2:4);if(usage){WORD palette[]={19,9,1,0};for(int i=0;i<count;i++)((WORD *)(info+40))[i]=palette[i];}else{DWORD palette[]={0x102030,0x405060,0x708090,0xa0b0c0};for(int i=0;i<count;i++)((DWORD *)(info+40))[i]=palette[i];}}
 if(sample==4||sample==7){bmi->bmiHeader.biCompression=BI_BITFIELDS;infoSize+=12;DWORD *m=(DWORD *)(info+40);m[0]=depth==16?0xf800:0x0000ff;m[1]=depth==16?0x07e0:0x00ff00;m[2]=depth==16?0x001f:0xff0000;}
 for(int y=0;y<3;y++)for(int x=0;x<3;x++){int n=y*3+x,at=y*stride;
 if(depth==1)bytes[at]|=(n%2)<<(7-x);else if(depth==4)bytes[at+x/2]|=(n%4)<<(x%2?0:4);else if(depth==8)bytes[at+x]=n%4;
 else if(depth==16){WORD p=sample==4?((3+n)<<11)|((15+n)<<5)|(1+n):((3+n)<<10)|((15+n)<<5)|(1+n);((WORD *)(bytes+at))[x]=p;}
 else if(depth==24){bytes[at+x*3]=17+n;bytes[at+x*3+1]=34+n;bytes[at+x*3+2]=51+n;}
 else ((DWORD *)(bytes+at))[x]=(0x80u<<24)|((51u+n)<<16)|((34u+n)<<8)|(17u+n);}
 for(int i=0;i<256;i++){dst[i]=0x70406080;}SetLastError(777);int result=StretchDIBits(dc,2,2,12,12,0,0,3,3,bytes,bmi,usage,SRCCOPY);DWORD error=GetLastError();
 printf("%s{\"name\":\"format-%u\",\"usage\":%d,\"info\":[",first?"":",\n",sample,usage);first=0;for(int i=0;i<infoSize;i++)printf("%s%u",i?",":"",info[i]);printf("],\"bytes\":[");for(int i=0;i<3*stride;i++)printf("%s%u",i?",":"",bytes[i]);printf("],\"result\":%d,\"error\":%lu,\"pixels\":[",result,error);for(int y=0;y<16;y++)for(int x=0;x<16;x++)printf("%s%lu",x||y?",":"",GetPixel(dc,x,y));printf("],\"raw\":[");for(int i=0;i<256;i++)printf("%s%lu",i?",":"",dst[i]);puts("]}");
 }
 puts("]");SelectObject(dc,old);DeleteObject(bitmap);DeleteDC(dc);return 0;}
