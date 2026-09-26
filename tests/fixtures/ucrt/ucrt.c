#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <stdio.h>
#define CHECK(c) do {if(!(c))ExitProcess(__LINE__);} while(0)
void start(void) {
 char *end, *p=malloc(8);CHECK(p);
 CHECK(strtoul("123tail",&end,10)==123 && *end=='t');
 CHECK(wcstoul(L"2a",0,16)==42 && wcslen(L"native UCRT")==11);
 memcpy(p,"native",7);CHECK(strlen(p)==6);
 p=realloc(p,64);CHECK(p && memcmp(p,"native",7)==0);
 void *z=calloc(8,4);CHECK(z);
 for(unsigned i=0;i<32;i++)CHECK(((unsigned char*)z)[i]==0);
 CHECK(__acrt_iob_func(1) && __acrt_iob_func(1)!=__acrt_iob_func(2));
 HMODULE heap=GetModuleHandleA("api-ms-win-crt-heap-l1-1-0.dll");
 HMODULE crt=GetModuleHandleW(L"ucrtbase.dll");CHECK(heap && heap==crt);
 HMODULE strings=LoadLibraryW(L"api-ms-win-crt-string-l1-1-0.dll");CHECK(strings==crt);
 size_t (__cdecl *length)(const char*)=(void*)GetProcAddress(strings,"strlen");
 CHECK(length && length(p)==6);CHECK(FreeLibrary(strings));
 CHECK(GetModuleHandleA("ucrtbase.dll")==crt && strlen(p)==6);
 free(p);free(z);
 DWORD written;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),"ucrt-ok\n",8,&written,0)&&written==8);
 ExitProcess(0);
}
