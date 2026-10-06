/* Authored MIT SDK checks for paths used by this image-loading GUI. */
static BOOL same_wide(const WCHAR *left,const WCHAR *right) {
#ifdef WINEBROWSER_HOST_SEARCH_CLIENT
    while(*left&&*left==*right){left++;right++;}return *left==*right;
#else
    return lstrcmpW(left,right)==0;
#endif
}
static void full_paths(void) {
    static CHAR path[512],expected[512],saved[512];static WCHAR wide[514];
    CHAR *part=(CHAR *)0x12345678;WCHAR *wide_part=(WCHAR *)0x12345678;
    CHECK(GetCurrentDirectoryA(512,saved));lstrcpyA(expected,saved);lstrcatA(expected,"\\ghost.bmp");
    DWORD length=(DWORD)lstrlenA(expected);
    CHECK(GetFullPathNameA("ghost.bmp",512,path,&part)==length);
    CHECK(!lstrcmpA(path,expected)&&!lstrcmpA(part,"ghost.bmp")&&part==path+length-9);
    CHECK(GetFullPathNameA("ghost.bmp",0,NULL,NULL)==length+1);
    for(unsigned i=0;i<514;i++)wide[i]=0xcccc;
    CHECK(GetFullPathNameW(L"ghost.bmp",length,wide,&wide_part)==length+1);
    CHECK(wide[0]==0xcccc&&!wide_part);
    CHECK(GetFullPathNameW(L".\\sub\\..\\ghost.bmp",512,wide,&wide_part)==length);
    CHECK(same_wide(wide_part,L"ghost.bmp")&&wide[length]==0);
    CHECK(wide[512]==0xcccc&&wide[513]==0xcccc);
    CHECK(GetFullPathNameA("C:\\ghost.bmp",512,path,&part)==12&&!lstrcmpA(path,"C:\\ghost.bmp")&&!lstrcmpA(part,"ghost.bmp"));
    CHECK(GetFullPathNameA("\\ghost.bmp",512,path,&part)==12&&!lstrcmpA(path,"C:\\ghost.bmp"));
    CHECK(GetFullPathNameA("C:ghost.bmp",512,path,&part)==length&&!lstrcmpA(path,expected));
    CHECK(GetFullPathNameW(L"C:\\",512,wide,&wide_part)==3&&!wide_part&&same_wide(wide,L"C:\\"));
    lstrcpyA(path,".\\ghost.bmp");CHECK(GetFullPathNameA(path,512,path,&part)==length&&!lstrcmpA(path,expected));
}
static void search_paths(void) {
    full_paths();
    CHAR path[MAX_PATH], saved[MAX_PATH], *part=(CHAR *)0x12345678;
    WCHAR wide[MAX_PATH], *wide_part=(WCHAR *)0x12345678;
    DWORD length=SearchPathA(NULL,"rgb24.bmp",NULL,MAX_PATH,path,&part);
    CHECK(length&&length==(DWORD)lstrlenA(path)&&part>path&&part<path+length);
    CHECK(!lstrcmpA(part,"rgb24.bmp")&&GetFileAttributesA(path)!=INVALID_FILE_ATTRIBUTES);
    HBITMAP bitmap=(HBITMAP)LoadImageA(NULL,path,IMAGE_BITMAP,0,0,LR_LOADFROMFILE);CHECK(bitmap&&DeleteObject(bitmap));
    CHECK(GetCurrentDirectoryA(MAX_PATH,saved));
    for(unsigned i=0;i<MAX_PATH;i++) wide[i]=0xcccc;
    wide_part=(WCHAR *)0x12345678;
    CHECK(SearchPathW(NULL,L"rgb24",L".bmp",1,wide,&wide_part)==length+1);
    CHECK(wide[0]==0xcccc&&!wide_part);
    CHECK(SearchPathW(NULL,L"rgb24",L".bmp",MAX_PATH,wide,&wide_part)==length);
    CHECK(same_wide(wide_part,L"rgb24.bmp")&&wide[length]==0&&wide[length+1]==0xcccc);
    CHECK(SearchPathA(NULL,"rgb24.bmp",NULL,0,NULL,NULL)==length+1);
    CHECK(!SearchPathA("missing-directory","rgb24.bmp",NULL,MAX_PATH,path,NULL)&&GetLastError()==ERROR_FILE_NOT_FOUND);
    CHECK(SearchPathA("missing-directory","./rgb24.bmp",NULL,MAX_PATH,path,&part)==length);
    CHECK(SearchPathW(NULL,L"rgb24.bmp",L".extra",MAX_PATH,wide,NULL)==length);
    CHECK(!SearchPathW(NULL,NULL,NULL,MAX_PATH,wide,NULL)&&GetLastError()==ERROR_INVALID_PARAMETER);
    CHECK(!SearchPathW(NULL,L"   ",NULL,MAX_PATH,wide,NULL)&&GetLastError()==ERROR_INVALID_PARAMETER);
    CHECK(!SearchPathW(NULL,L"\t",NULL,MAX_PATH,wide,NULL)&&GetLastError()==ERROR_FILE_NOT_FOUND);
    CHECK(CreateDirectoryA("search-a",NULL)&&CreateDirectoryA("search-b",NULL));
    HANDLE file=CreateFileA("search-a/choice.bin",GENERIC_WRITE,0,NULL,CREATE_ALWAYS,0,NULL);CHECK(file!=INVALID_HANDLE_VALUE&&CloseHandle(file));
    file=CreateFileA("search-b/choice.bin",GENERIC_WRITE,0,NULL,CREATE_ALWAYS,0,NULL);CHECK(file!=INVALID_HANDLE_VALUE&&CloseHandle(file));
    file=CreateFileA("search-b/path-only.dat",GENERIC_WRITE,0,NULL,CREATE_ALWAYS,0,NULL);CHECK(file!=INVALID_HANDLE_VALUE&&CloseHandle(file));
    CHECK(SearchPathA("search-b;search-a","choice", ".bin",MAX_PATH,path,&part));
    CHECK(!lstrcmpA(part,"choice.bin"));
    CHAR expected[MAX_PATH];lstrcpyA(expected,saved);lstrcatA(expected,"\\search-b\\choice.bin");CHECK(!lstrcmpiA(path,expected));
    BYTE copied[512];DWORD count,written;
    HANDLE input=CreateFileA("rgb24.bmp",GENERIC_READ,7,NULL,OPEN_EXISTING,0,NULL);CHECK(input!=INVALID_HANDLE_VALUE);
    CHECK(ReadFile(input,copied,sizeof(copied),&count,NULL)&&count&&count<sizeof(copied)&&CloseHandle(input));
    HANDLE output=CreateFileA("search-a/nested.bmp",GENERIC_WRITE,7,NULL,CREATE_ALWAYS,0,NULL);CHECK(output!=INVALID_HANDLE_VALUE);
    CHECK(WriteFile(output,copied,count,&written,NULL)&&written==count&&CloseHandle(output));
    CHECK(SetCurrentDirectoryA("search-a"));
    bitmap=(HBITMAP)LoadImageW(NULL,L"nested.bmp",IMAGE_BITMAP,0,0,LR_LOADFROMFILE|LR_CREATEDIBSECTION);CHECK(bitmap&&DeleteObject(bitmap));
    CHECK(SearchPathA(NULL,"rgb24.bmp",NULL,MAX_PATH,path,&part)==length);
    lstrcpyA(expected,saved);lstrcatA(expected,"\\search-b");CHECK(SetEnvironmentVariableA("PATH",expected));
    CHECK(SearchPathW(NULL,L"path-only",L".dat",MAX_PATH,wide,&wide_part));
    CHECK(same_wide(wide_part,L"path-only.dat"));
    CHECK(SearchPathW(NULL,L"rgb24",L".bmp",MAX_PATH,wide,&wide_part)==length);
    bitmap=(HBITMAP)LoadImageW(NULL,wide,IMAGE_BITMAP,0,0,LR_LOADFROMFILE|LR_CREATEDIBSECTION);CHECK(bitmap&&DeleteObject(bitmap));
    CHECK(SetSearchPathMode(BASE_SEARCH_PATH_ENABLE_SAFE_SEARCHMODE));
    CHECK(SearchPathW(NULL,L"rgb24.bmp",NULL,MAX_PATH,wide,NULL)==length);
    CHECK(SetSearchPathMode(BASE_SEARCH_PATH_DISABLE_SAFE_SEARCHMODE));
    CHECK(!SetSearchPathMode(0)&&GetLastError()==ERROR_INVALID_PARAMETER);
    CHECK(SetEnvironmentVariableA("PATH","C:\\"));
    CHECK(SetCurrentDirectoryA(saved));
    CHECK(DeleteFileA("search-a/nested.bmp"));
    CHECK(DeleteFileA("search-a/choice.bin")&&DeleteFileA("search-b/choice.bin")&&DeleteFileA("search-b/path-only.dat"));
    CHECK(RemoveDirectoryA("search-a")&&RemoveDirectoryA("search-b"));
}
