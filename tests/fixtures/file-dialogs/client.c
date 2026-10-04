// Original MIT fixture: genuine native common-dialog calls and filesystem I/O.
#include <windows.h>
#include <commdlg.h>
void *memset(void *p,int v,size_t n) { volatile unsigned char *b=p;while(n--) *b++=(unsigned char)v;return p; }
static void check(int condition,UINT code) { if (!condition) ExitProcess(code); }
static int equalA(const char *a,const char *b) { while (*a && *a==*b) { a++;b++; } return *a==*b; }
static int equalW(const WCHAR *a,const WCHAR *b) { while (*a && *a==*b) { a++;b++; } return *a==*b; }
static const char filtersA[]="Text documents\0*.txt;*.log\0All files\0*.*\0";
static const WCHAR filtersW[]=L"Text documents\0*.txt;*.log\0All files\0*.*\0";
static char nameA[512],titleA[64];
static WCHAR nameW[512],titleW[64];
static void resetA(OPENFILENAMEA *p) { ZeroMemory(p,sizeof(*p));p->lStructSize=sizeof(*p);p->lpstrFile=nameA;p->nMaxFile=512;p->lpstrFileTitle=titleA;p->nMaxFileTitle=64;p->lpstrFilter=filtersA;p->nFilterIndex=1;nameA[0]=0; }
static void resetW(OPENFILENAMEW *p) { ZeroMemory(p,sizeof(*p));p->lStructSize=sizeof(*p);p->lpstrFile=nameW;p->nMaxFile=512;p->lpstrFileTitle=titleW;p->nMaxFileTitle=64;p->lpstrFilter=filtersW;p->nFilterIndex=1;nameW[0]=0; }
void start(void) {
 OPENFILENAMEA a;OPENFILENAMEW w;DWORD count;char data[16];
 resetA(&a);a.lStructSize=OPENFILENAME_SIZE_VERSION_400A;a.lpstrTitle="Native cancel preserves filename";
 nameA[0]='k';nameA[1]='e';nameA[2]='e';nameA[3]='p';nameA[4]=0;
 check(!GetOpenFileNameA(&a) && CommDlgExtendedError()==0 && equalA(nameA,"keep"),81);
 resetA(&a);a.lpstrTitle="Native A text selection";a.Flags=OFN_FILEMUSTEXIST|OFN_PATHMUSTEXIST|OFN_NOCHANGEDIR;
 check(GetOpenFileNameA(&a),82);check(equalA(nameA,"C:\\winebrowser\\docs\\one.txt") && equalA(titleA,"one.txt"),83);
 check(a.nFileOffset==20 && a.nFileExtension==24 && a.nFilterIndex==1,84);
 HANDLE file=CreateFileA(nameA,GENERIC_READ,FILE_SHARE_READ,0,OPEN_EXISTING,0,0);
 check(file!=INVALID_HANDLE_VALUE && ReadFile(file,data,5,&count,0) && count==5 && data[0]=='f' && data[4]=='t',85);CloseHandle(file);
 resetW(&w);w.lpstrTitle=L"Native Unicode Save As";w.lpstrDefExt=L"txt";w.Flags=OFN_PATHMUSTEXIST|OFN_NOCHANGEDIR;
 check(GetSaveFileNameW(&w),86);check(equalW(nameW,L"C:\\winebrowser\\docs\\unicode-\x03a9.txt") && equalW(titleW,L"unicode-\x03a9.txt"),87);
 check(w.nFileOffset==20 && w.nFileExtension==30 && !(w.Flags&OFN_EXTENSIONDIFFERENT),88);
 // Save As only chooses a name. The native caller creates and writes the file.
 check(GetFileAttributesW(nameW)==INVALID_FILE_ATTRIBUTES,89);
 file=CreateFileW(nameW,GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 check(file!=INVALID_HANDLE_VALUE && WriteFile(file,"native save",11,&count,0) && count==11,90);CloseHandle(file);
 resetW(&w);w.lpstrTitle=L"Native Unicode multiselect";w.Flags=OFN_EXPLORER|OFN_ALLOWMULTISELECT|OFN_FILEMUSTEXIST|OFN_NOCHANGEDIR;
 check(GetOpenFileNameW(&w),91);
 check(equalW(nameW,L"C:\\winebrowser\\docs") && equalW(nameW+20,L"one.txt") && equalW(nameW+28,L"two.txt") && nameW[36]==0,92);
 check(w.nFileOffset==20 && w.nFileExtension==0,93);
 resetA(&a);a.lpstrTitle="Native capacity error";a.nMaxFile=4;
 check(!GetOpenFileNameA(&a) && CommDlgExtendedError()==FNERR_BUFFERTOOSMALL && *(WORD *)nameA==28,94);
 resetA(&a);a.lpstrTitle="Native stop lifecycle";
 check(!GetOpenFileNameA(&a),95);
 // Browser acceptance cancels once; a second run terminates at this picker.
 HANDLE output=GetStdHandle(STD_OUTPUT_HANDLE);WriteFile(output,"native file dialogs passed\n",27,&count,0);
 ExitProcess(0);
}
