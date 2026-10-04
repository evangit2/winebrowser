/* Original MIT PE32 fixture for legacy Windows text APIs. */
#include <windows.h>
#define CHECK(x) do {if(!(x))ExitProcess(__LINE__);} while(0)
void start(void) {
  char a[16]={'x','x','x'},accent[]={'C',(char)0x80,(char)0xe9,0};
  CHECK(lstrcpyA(a,accent)==a);CHECK(a[1]==(char)0x80 && a[2]==(char)0xe9 && a[3]==0);
  CHECK(lstrcatA(a,"!")==a);CHECK(a[3]=='!' && a[4]==0);
  CHECK(lstrcpynA(a,"abcdef",4)==a && a[0]=='a' && a[2]=='c' && a[3]==0);
  a[0]='z';CHECK(lstrcpynA(a,"abcdef",0)==a && a[0]=='z');CHECK(lstrcpynA(a,NULL,1)==a && !a[0]);
  WCHAR w[16];CHECK(lstrcpyW(w,L"Unicode \x03bb")==w && w[8]==0x03bb && !w[9]);
  CHECK(lstrcatW(w,L"!")==w && w[9]=='!' && !w[10]);
  CHECK(lstrcpynW(w,L"\x03a9xyz",3)==w && w[0]==0x03a9 && w[1]=='x' && !w[2]);
  CHECK(IsCharAlphaA((CHAR)0xe9) && IsCharLowerA((CHAR)0xe9) && !IsCharUpperA((CHAR)0xe9));
  CHECK(IsCharUpperA('A') && !IsCharAlphaA('1') && IsCharAlphaNumericA('1') && !IsCharAlphaNumericA('!'));
  CHECK(IsCharAlphaW(0x03bb) && IsCharLowerW(0x03bb) && IsCharUpperW(0x03a9));
  char input[]={(char)0xe9,0,'x'},output[6]={'!','!','!','!','!','!'};
  CHECK(CharToOemBuffA(input,output,3));CHECK(output[0]==(char)0x82 && !output[1] && output[2]=='x' && output[3]=='!');
  CHECK(OemToCharBuffA(output,output,3));CHECK(output[0]==(char)0xe9 && !output[1] && output[2]=='x' && output[3]=='!');
  CHECK(CharToOemA("caf\xe9",output));CHECK(output[3]==(char)0x82 && !output[4]);
  CHECK(OemToCharA(output,output));CHECK(output[3]==(char)0xe9 && !output[4]);
  WCHAR source[]={0x00c7,0,0x00e9},decoded[4]={0,0,0,0xdddd};
  CHECK(CharToOemBuffW(source,output,3));CHECK(output[0]==(char)0x80 && !output[1] && output[2]==(char)0x82);
  CHECK(OemToCharBuffW(output,decoded,3));CHECK(decoded[0]==0x00c7 && !decoded[1] && decoded[2]==0x00e9 && decoded[3]==0xdddd);
  WORD types[8]={0};CHECK(GetStringTypeA(0x0409,CT_CTYPE1,"A0 \t!",-1,types));
  CHECK((types[0]&(C1_UPPER|C1_ALPHA|C1_XDIGIT))==(C1_UPPER|C1_ALPHA|C1_XDIGIT) && !(types[0]&C1_DIGIT));
  CHECK((types[1]&(C1_DIGIT|C1_XDIGIT))==(C1_DIGIT|C1_XDIGIT) && !(types[1]&C1_ALPHA));
  CHECK(types[2]&C1_BLANK && types[3]&C1_CNTRL && types[4]&C1_PUNCT && types[5]&C1_CNTRL);
  CHECK(GetStringTypeW(CT_CTYPE1,L"\x03bb\x03a9\x00e9",3,types));CHECK(types[0]&C1_LOWER && types[1]&C1_UPPER && types[2]&C1_ALPHA);
  CHECK(GetStringTypeA(0x0409,CT_CTYPE1,accent+2,1,types));CHECK(types[0]&C1_LOWER);
  CHECK(!GetStringTypeW(CT_CTYPE2,L"x",1,types) && GetLastError()==ERROR_INVALID_PARAMETER);
  CHECK(GetDialogBaseUnits()==MAKELONG(8,16));
  DWORD written;HANDLE out=GetStdHandle(STD_OUTPUT_HANDLE);static const char message[]="legacy-text-ok\r\n";
  CHECK(WriteFile(out,message,sizeof(message)-1,&written,NULL));CHECK(written==sizeof(message)-1);ExitProcess(0);
}
