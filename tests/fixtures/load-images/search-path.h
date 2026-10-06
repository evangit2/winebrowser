/* Authored MIT SDK checks for paths used by this image-loading GUI. */
static BOOL same_wide(const WCHAR *left,const WCHAR *right) {
#ifdef WINEBROWSER_HOST_SEARCH_CLIENT
    while(*left&&*left==*right){left++;right++;}return *left==*right;
#else
    return lstrcmpW(left,right)==0;
#endif
}
static void search_paths(void) {
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
    CHECK(SetCurrentDirectoryA("search-a"));
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
    CHECK(DeleteFileA("search-a/choice.bin")&&DeleteFileA("search-b/choice.bin")&&DeleteFileA("search-b/path-only.dat"));
    CHECK(RemoveDirectoryA("search-a")&&RemoveDirectoryA("search-b"));
}
