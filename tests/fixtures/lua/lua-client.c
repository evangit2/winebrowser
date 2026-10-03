// SPDX-License-Identifier: MIT
#include <windows.h>
typedef void lua_State;
typedef long long lua_Integer;
static lua_Integer (__cdecl *tointeger)(lua_State *,int,int *);
static void (__cdecl *pushinteger)(lua_State *,lua_Integer);
static int __cdecl native_sum(lua_State *state){
 int left_ok=0,right_ok=0;
 lua_Integer left=tointeger(state,1,&left_ok),right=tointeger(state,2,&right_ok);
 if(!left_ok||!right_ok)ExitProcess(6);
 pushinteger(state,left+right);return 1;
}
#define CHECK(x,n) do {if(!(x))ExitProcess(n);}while(0)
void _start(void){
 HMODULE dll=LoadLibraryA("lua54.dll");CHECK(dll,1);
 lua_State *(__cdecl *newstate)(void)=(void*)GetProcAddress(dll,"luaL_newstate");
 void (__cdecl *openlibs)(lua_State*)=(void*)GetProcAddress(dll,"luaL_openlibs");
 int (__cdecl *loadfile)(lua_State*,const char*,const char*)=(void*)GetProcAddress(dll,"luaL_loadfilex");
 int (__cdecl *pcall)(lua_State*,int,int,int,int,void*)=(void*)GetProcAddress(dll,"lua_pcallk");
 const char *(__cdecl *string)(lua_State*,int,void*)=(void*)GetProcAddress(dll,"lua_tolstring");
 void (__cdecl *close)(lua_State*)=(void*)GetProcAddress(dll,"lua_close");
 void (__cdecl *pushclosure)(lua_State *,int (__cdecl *)(lua_State *),int)=(void*)GetProcAddress(dll,"lua_pushcclosure");
 void (__cdecl *setglobal)(lua_State *,const char *)=(void*)GetProcAddress(dll,"lua_setglobal");
 tointeger=(void*)GetProcAddress(dll,"lua_tointegerx");pushinteger=(void*)GetProcAddress(dll,"lua_pushinteger");
 CHECK(newstate&&openlibs&&loadfile&&pcall&&close&&string&&pushclosure&&setglobal&&tointeger&&pushinteger,2);
 lua_State *state=newstate();CHECK(state,3);openlibs(state);
 pushclosure(state,native_sum,0);setglobal(state,"native_sum");
 int loaded=loadfile(state,"main.lua",0),status=loaded?loaded:pcall(state,0,0,0,0,0);
 if(status){const char *error=string(state,-1,0);if(!error)error="Lua error (non-string value)";DWORD written;DWORD count=0;while(error[count])count++;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),error,count,&written,0);ExitProcess(100+status);}
 close(state);CHECK(FreeLibrary(dll),5);
 const char message[]="LUA SCRIPT/DLL PASS\n";DWORD written;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),message,sizeof(message)-1,&written,0);ExitProcess(0);
}
