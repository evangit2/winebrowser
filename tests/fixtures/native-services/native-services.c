// SPDX-License-Identifier: MIT
#include <windows.h>
#include <wincrypt.h>
#include <bcrypt.h>
#include <shlwapi.h>
static void report(const char *s) {DWORD length=0,written=0;while(s[length])length++;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),s,length,&written,0);}
#define CHECK(value,code) do{if(!(value)){report("NATIVE SERVICES FAIL\n");ExitProcess(code);}}while(0)
static int same(const WCHAR *a,const WCHAR *b){while(*a&&*a==*b){a++;b++;}return *a==*b;}
void _start(void){
  WCHAR path[260];
  CHECK(PathCanonicalizeW(path,L"C:\\winebrowser\\dir\\..\\folder\\.\\sub")&&same(path,L"C:\\winebrowser\\folder\\sub"),1);
  CHECK(PathCombineW(path,L"C:\\winebrowser\\app",L"\\folder\\..\\next")==path&&same(path,L"C:\\next"),2);
  CHECK(same(PathSkipRootW(L"\\\\server\\share\\folder"),L"folder"),3);
  char ansi[260];CHECK(PathCanonicalizeA(ansi,"C:\\a\\..\\b")&&ansi[0]=='C'&&ansi[3]=='b'&&ansi[4]==0,4);
  WCHAR text[]=L"Ab\x00c4\x03a3";CHECK(CharLowerBuffW(text,4)==4&&same(text,L"ab\x00e4\x03c3"),5);
  CHECK(GetModuleFileNameW(0,path,260)>0,6);
  DWORD ignored=0, size=GetFileVersionInfoSizeW(path,&ignored);CHECK(size>0,7);
  BYTE *data=HeapAlloc(GetProcessHeap(),0,size);CHECK(data&&GetFileVersionInfoW(path,0,size,data),8);
  VS_FIXEDFILEINFO *version=0;UINT length=0;
  CHECK(VerQueryValueW(data,L"\\",(void **)&version,&length)&&length==sizeof(*version),9);
  CHECK(version->dwSignature==0xfeef04bd&&version->dwFileVersionMS==0x00020003&&version->dwFileVersionLS==0x00040005,10);
  CHECK(HeapFree(GetProcessHeap(),0,data),11);
  BYTE *random=HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,65539);CHECK(random,12);
  random[0]=0x91;random[65538]=0x79;
  HCRYPTPROV provider=0;CHECK(CryptAcquireContextW(&provider,0,0,PROV_RSA_FULL,CRYPT_VERIFYCONTEXT|CRYPT_SILENT),13);
  CHECK(CryptGenRandom(provider,65537,random+1)&&random[0]==0x91&&random[65538]==0x79,14);
  CHECK(CryptContextAddRef(provider,0,0)&&CryptReleaseContext(provider,0),15);
  CHECK(CryptGenRandom(provider,17,random+1)&&CryptReleaseContext(provider,0),16);
  CHECK(!CryptGenRandom(provider,17,random+1)&&GetLastError()==ERROR_INVALID_PARAMETER,17);
  CHECK(BCryptGenRandom(0,random+1,65537,BCRYPT_USE_SYSTEM_PREFERRED_RNG)==0&&random[0]==0x91&&random[65538]==0x79,18);
  CHECK(HeapFree(GetProcessHeap(),0,random),19);
  HKEY key=0,connected=0;CHECK(RegCreateKeyW(HKEY_CURRENT_USER,L"Software\\NativeServices",&key)==0,20);
  CHECK(RegSetValueW(key,L"Child",REG_SZ,L"Unicode \x00e9",1)==0,21);
  LONG count=sizeof(text);CHECK(RegQueryValueW(key,L"Child",text,&count)==ERROR_MORE_DATA&&count==20,22);
  count=sizeof(path);CHECK(RegQueryValueW(key,L"Child",path,&count)==0&&same(path,L"Unicode \x00e9")&&count==20,23);
  count=sizeof(path);CHECK(RegQueryValueW(key,0,path,&count)==0&&path[0]==0&&count==2,24);
  CHECK(RegConnectRegistryW(0,HKEY_CURRENT_USER,&connected)==0&&connected,25);
  CHECK(RegFlushKey(key)==0&&RegCloseKey(connected)==0,26);
  CHECK(RegSaveKeyW(key,L"unsupported.hive",0)==ERROR_NOT_SUPPORTED,27);
  CHECK(RegLoadKeyW(key,L"Hive",L"unsupported.hive")==ERROR_NOT_SUPPORTED,28);
  CHECK(RegConnectRegistryW(L"remote-host",HKEY_CURRENT_USER,&connected)==ERROR_BAD_NETPATH,29);
  CHECK(RegCloseKey(key)==0,30);
  HANDLE event=CreateEventW(0,TRUE,FALSE,0);DWORD flags=0;
  CHECK(event&&SetHandleInformation(event,HANDLE_FLAG_INHERIT|HANDLE_FLAG_PROTECT_FROM_CLOSE,3),31);
  CHECK(GetHandleInformation(event,&flags)&&flags==3,32);
  CHECK(!CloseHandle(event)&&GetLastError()==ERROR_INVALID_HANDLE&&SetEvent(event),33);
  CHECK(SetHandleInformation(event,HANDLE_FLAG_PROTECT_FROM_CLOSE,0),34);
  CHECK(GetHandleInformation(event,&flags)&&flags==1&&CloseHandle(event),35);
  report("NATIVE SERVICES PASS\n");ExitProcess(0);
}
