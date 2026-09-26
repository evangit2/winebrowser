#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while(0)
static WCHAR unicode[] = {'A',0xc4,0x391,0x410,0x130,0xd801,0xdc00,0xd800,'Z',0,0x5a5a};
static const WCHAR lower[] = {'a',0xe4,0x3b1,0x430,0x130,0xd801,0xdc28,0xd800,'z',0,0x5a5a};
static const WCHAR upper[] = {'A',0xc4,0x391,0x410,0x130,0xd801,0xdc00,0xd800,'Z',0,0x5a5a};
static WCHAR counted[] = {'A',0,'B','C',0x5a5a};
static char ansi[] = {'A',(char)0xc4,'Z',0,0x5a};
static char counted_ansi[] = {'A',0,'B','C',0x5a};
void start(void)
{
    CHECK((ULONG_PTR)CharLowerW((LPWSTR)'A') == 'a');
    CHECK((ULONG_PTR)CharUpperW((LPWSTR)'a') == 'A');
    CHECK((ULONG_PTR)CharLowerW((LPWSTR)0x391) == 0x3b1);
    CHECK((ULONG_PTR)CharUpperW((LPWSTR)0x430) == 0x410);
    CHECK((ULONG_PTR)CharLowerW((LPWSTR)0xd800) == 0xd800);
    CHECK(CharLowerW(0) == 0 && CharUpperW(0) == 0);
    CHECK(CharLowerW(unicode) == unicode);
    for (UINT i=0;i<sizeof(lower)/sizeof(lower[0]);i++) CHECK(unicode[i]==lower[i]);
    CHECK(CharUpperW(unicode) == unicode);
    for (UINT i=0;i<sizeof(upper)/sizeof(upper[0]);i++) CHECK(unicode[i]==upper[i]);
    CHECK(CharLowerBuffW(counted,3) == 3);
    CHECK(counted[0]=='a' && !counted[1] && counted[2]=='b' && counted[3]=='C' && counted[4]==0x5a5a);
    CHECK(CharUpperBuffW(counted,3) == 3);
    CHECK(counted[0]=='A' && !counted[1] && counted[2]=='B' && counted[3]=='C' && counted[4]==0x5a5a);
    CHECK(CharLowerBuffW(0,1)==0 && CharUpperBuffW(0,1)==0);
    CHECK((ULONG_PTR)CharLowerA((LPSTR)'A') == 'a');
    CHECK((ULONG_PTR)CharUpperA((LPSTR)'a') == 'A');
    CHECK(CharLowerA(ansi)==ansi);
    CHECK(ansi[0]=='a' && (BYTE)ansi[1]==0xe4 && ansi[2]=='z' && !ansi[3] && ansi[4]==0x5a);
    CHECK(CharUpperA(ansi)==ansi);
    CHECK(ansi[0]=='A' && (BYTE)ansi[1]==0xc4 && ansi[2]=='Z' && !ansi[3] && ansi[4]==0x5a);
    CHECK(CharLowerBuffA(counted_ansi,3)==3);
    CHECK(counted_ansi[0]=='a' && !counted_ansi[1] && counted_ansi[2]=='b' && counted_ansi[3]=='C' && counted_ansi[4]==0x5a);
    CHECK(CharUpperBuffA(counted_ansi,3)==3);
    CHECK(counted_ansi[0]=='A' && !counted_ansi[1] && counted_ansi[2]=='B' && counted_ansi[3]=='C' && counted_ansi[4]==0x5a);
    CHECK(CharLowerBuffA(0,1)==0 && CharUpperBuffA(0,1)==0);
    ExitProcess(0);
}
