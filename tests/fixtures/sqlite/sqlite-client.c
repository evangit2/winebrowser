// SPDX-License-Identifier: MIT
#include <windows.h>
typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;
static int (__cdecl *sql_open)(const char *,sqlite3 **);
static int (__cdecl *sql_close)(sqlite3 *);
static int (__cdecl *sql_exec)(sqlite3 *,const char *,void *,void *,char **);
static int (__cdecl *sql_prepare)(sqlite3 *,const char *,int,sqlite3_stmt **,const char **);
static int (__cdecl *sql_step)(sqlite3_stmt *);
static int (__cdecl *sql_column_int)(sqlite3_stmt *,int);
static const unsigned char *(__cdecl *sql_column_text)(sqlite3_stmt *,int);
static int (__cdecl *sql_finalize)(sqlite3_stmt *);
static const char *(__cdecl *sql_errmsg)(sqlite3 *);
static int (__cdecl *sql_version)(void);
static void report(const char *s){DWORD n=0,w;while(s[n])n++;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),s,n,&w,0);}
#define CHECK(x,n) do{if(!(x)){report("SQLITE FAIL " #n "\n");if(db)report(sql_errmsg(db));ExitProcess(n);}}while(0)
#define LOAD(symbol,target) do{target=(void *)GetProcAddress(module,symbol);if(!target)ExitProcess(1);}while(0)
static void test(const char *path,int persisted){
 sqlite3 *db=0;sqlite3_stmt *stmt=0;
 CHECK(sql_open(path,&db)==0,2);
 CHECK(sql_exec(db,"CREATE TABLE sample(id INTEGER PRIMARY KEY,label TEXT,data BLOB); INSERT INTO sample VALUES(1,'database ✓',X'0102FF'); BEGIN; INSERT INTO sample VALUES(2,'rollback',NULL); ROLLBACK;",0,0,0)==0,3);
 CHECK(sql_prepare(db,"SELECT count(*),sum(id),hex(data),label FROM sample",-1,&stmt,0)==0,4);
 CHECK(sql_step(stmt)==100&&sql_column_int(stmt,0)==1&&sql_column_int(stmt,1)==1,5);
 CHECK(sql_column_text(stmt,2)[0]=='0'&&sql_column_text(stmt,2)[4]=='F',6);
 CHECK(sql_finalize(stmt)==0,7);stmt=0;
 CHECK(sql_close(db)==0,8);db=0;
 if(persisted){
  sqlite3 *other=0;
  CHECK(sql_open(path,&db)==0,20);CHECK(sql_open(path,&other)==0,21);
  CHECK(sql_exec(db,"BEGIN IMMEDIATE",0,0,0)==0,22);
  CHECK(sql_exec(other,"BEGIN IMMEDIATE",0,0,0)==5,23);
  CHECK(sql_exec(db,"ROLLBACK",0,0,0)==0,24);
  CHECK(sql_exec(other,"BEGIN IMMEDIATE;ROLLBACK",0,0,0)==0,25);
  CHECK(sql_close(other)==0&&sql_close(db)==0,26);db=0;
  report("SQLITE CONTENTION PASS\n");
  CHECK(sql_open(path,&db)==0,9);
  CHECK(sql_prepare(db,"SELECT label FROM sample WHERE id=1",-1,&stmt,0)==0,10);
  CHECK(sql_step(stmt)==100&&sql_column_text(stmt,0)[0]=='d'&&sql_column_text(stmt,0)[9]==0xe2,11);
  CHECK(sql_finalize(stmt)==0,12);stmt=0;
  CHECK(sql_prepare(db,"PRAGMA integrity_check",-1,&stmt,0)==0,13);
  CHECK(sql_step(stmt)==100&&sql_column_text(stmt,0)[0]=='o'&&sql_column_text(stmt,0)[1]=='k',14);
  CHECK(sql_finalize(stmt)==0,15);CHECK(sql_close(db)==0,16);
 }
}
void _start(void){
 HMODULE module=LoadLibraryA("sqlite3.dll");if(!module)ExitProcess(1);
 LOAD("sqlite3_open",sql_open);LOAD("sqlite3_close",sql_close);LOAD("sqlite3_exec",sql_exec);
 LOAD("sqlite3_prepare_v2",sql_prepare);LOAD("sqlite3_step",sql_step);LOAD("sqlite3_column_int",sql_column_int);
 LOAD("sqlite3_column_text",sql_column_text);LOAD("sqlite3_finalize",sql_finalize);LOAD("sqlite3_errmsg",sql_errmsg);
 LOAD("sqlite3_libversion_number",sql_version);if(sql_version()!=3050004)ExitProcess(17);
 test(":memory:",0);report("SQLITE MEMORY PASS\n");test("database.db",1);report("SQLITE DISK PASS\n");
 if(!FreeLibrary(module))ExitProcess(18);
 report("SQLITE NATIVE DLL PASS\n");ExitProcess(0);
}
