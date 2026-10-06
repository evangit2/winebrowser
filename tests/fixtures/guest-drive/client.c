/* Original WineBrowser contributors, MIT. Native Windows SDK input. */
#include <windows.h>
#include <commdlg.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000 + __LINE__); } while (0)
#define TOTAL_BYTES (128ULL * 1024 * 1024)
#ifndef VOLUME_HOST
static HWND root, controls[4];
static DWORD file_size;
static WCHAR selected[1024];
static const WCHAR filename[] = L"volume-demo.bin";
static BYTE payload[8192];
#endif
static ULARGE_INTEGER initial_free, current_free;
static BOOL same(const WCHAR *a, const WCHAR *b) { while (*a && *a == *b) { a++; b++; } return *a == *b; }
static void verify(void) {
#ifndef VOLUME_HOST
    CHECK(!lstrcmpW(L"native", L"native")); /* Ordinary import selects native Wine base DLLs. */
#endif
    struct { ULARGE_INTEGER available, total, free; DWORD guard; } ex;
    struct { DWORD sectors, bytes, free, total, guard; } disk;
    static const WCHAR *roots[] = {NULL, L"C:\\", L"C:\\winebrowser\\"};
    for (unsigned i=0;i<3;i++) {
        ex.guard = 0x12345678;
        CHECK(GetDiskFreeSpaceExW(roots[i], &ex.available, &ex.total, &ex.free));
        CHECK(ex.guard == 0x12345678 && ex.total.QuadPart == TOTAL_BYTES && ex.free.QuadPart <= ex.total.QuadPart && ex.available.QuadPart == ex.free.QuadPart);
        disk.guard = 0x12345678;
        CHECK(GetDiskFreeSpaceW(roots[i], &disk.sectors, &disk.bytes, &disk.free, &disk.total));
        CHECK(disk.guard == 0x12345678 && disk.sectors == 8 && disk.bytes == 512 && (ULONGLONG)disk.total * 4096 == ex.total.QuadPart && (ULONGLONG)disk.free * 4096 == ex.free.QuadPart);
        CHECK(GetDiskFreeSpaceExW(roots[i], NULL, &ex.total, NULL));
    }
    CHECK(GetDiskFreeSpaceExA("C:\\", &ex.available, &ex.total, &ex.free));
    CHECK(GetDiskFreeSpaceA("C:\\winebrowser\\", &disk.sectors, &disk.bytes, &disk.free, &disk.total));
    for (unsigned i=0;i<2;i++) {
        const WCHAR *missing = i ? L"D:\\" : L"C:\\winebrowser\\missing";
        ex.total.QuadPart = 0x123456789abcdef0ULL;
        CHECK(!GetDiskFreeSpaceExW(missing, NULL, &ex.total, NULL) && GetLastError() == (i ? ERROR_PATH_NOT_FOUND : ERROR_FILE_NOT_FOUND) && ex.total.QuadPart == 0x123456789abcdef0ULL);
    }
    CHECK(GetLogicalDrives() == 4);
    CHECK(GetLogicalDriveStringsA(0, NULL) == 5 && GetLogicalDriveStringsW(0, NULL) == 5);
    for (unsigned capacity=1;capacity<=5;capacity++) {
        WCHAR drives[8];CHAR ansi[8];
        for (unsigned i=0;i<8;i++) { drives[i]=0xcccc; ansi[i]=(CHAR)0xcc; }
        CHECK(GetLogicalDriveStringsW(capacity,drives) == (capacity < 5 ? 5 : 4));
        CHECK(GetLogicalDriveStringsA(capacity,ansi) == (capacity < 5 ? 5 : 4));
        if (capacity < 5) CHECK(drives[0] == 0xcccc && (BYTE)ansi[0] == 0xcc);
        else CHECK(same(drives,L"C:\\") && !drives[4] && ansi[0]=='C' && ansi[1]==':' && ansi[2]=='\\' && !ansi[3] && !ansi[4]);
        CHECK(drives[5] == 0xcccc && (BYTE)ansi[5] == 0xcc);
    }
    CHECK(GetDiskFreeSpaceExW(NULL,NULL,NULL,&initial_free));
    current_free = initial_free;
}
#ifndef VOLUME_HOST
static void changed(const WCHAR *title) {
    CHECK(GetDiskFreeSpaceExW(NULL, NULL, NULL, &current_free));
    CHECK(current_free.QuadPart + file_size == initial_free.QuadPart);
    EnableWindow(controls[1],file_size>4096);EnableWindow(controls[2],file_size>0);
    CHECK(SetWindowTextW(root,title) && InvalidateRect(root,NULL,TRUE));
}
static void write_file(void) {
    HANDLE file=CreateFileW(filename,GENERIC_WRITE,0,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);CHECK(file!=INVALID_HANDLE_VALUE);
    DWORD written=0;CHECK(WriteFile(file,payload,sizeof(payload),&written,NULL) && written==sizeof(payload));CHECK(CloseHandle(file));
    file_size=sizeof(payload);changed(L"Guest drive — wrote 8192 bytes");
}
static void shrink_file(void) {
    HANDLE file=CreateFileW(filename,GENERIC_WRITE,0,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);CHECK(file!=INVALID_HANDLE_VALUE);
    CHECK(SetFilePointer(file,4096,NULL,FILE_BEGIN)==4096 && SetEndOfFile(file) && CloseHandle(file));
    file_size=4096;changed(L"Guest drive — resized to 4096 bytes");
}
static void delete_file(void) {
    CHECK(DeleteFileW(filename));file_size=0;changed(L"Guest drive — deleted file, capacity restored");
}
static void draw_number(HDC dc,int y,const WCHAR *prefix,DWORD value) {
    WCHAR line[128],digits[24];unsigned count=0,length=0;
    while(prefix[length]) { line[length]=prefix[length];length++; }
    do { digits[count++]=(WCHAR)('0'+value%10);value/=10; } while(value);
    while(count){line[length++]=digits[--count];}
    line[length]=0;CHECK(TextOutW(dc,20,y,line,(int)length));
}
static void open_file(void) {
    OPENFILENAMEW dialog={0};selected[0]=0;dialog.lStructSize=sizeof(dialog);dialog.hwndOwner=root;
    dialog.lpstrFile=selected;dialog.nMaxFile=1024;dialog.lpstrTitle=L"Open a file on the guest drive";
    dialog.lpstrFilter=L"All files\0*.*\0\0";dialog.Flags=OFN_EXPLORER|OFN_FILEMUSTEXIST|OFN_PATHMUSTEXIST|OFN_NOCHANGEDIR;
    if(!GetOpenFileNameW(&dialog)){CHECK(!CommDlgExtendedError());return;}
    HANDLE file=CreateFileW(selected,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,0,NULL);CHECK(file!=INVALID_HANDLE_VALUE);
    BYTE first;DWORD read;CHECK(ReadFile(file,&first,1,&read,NULL) && CloseHandle(file));
    CHECK(GetDiskFreeSpaceExW(NULL,NULL,NULL,&current_free));initial_free.QuadPart=current_free.QuadPart+file_size;
    CHECK(SetWindowTextW(root,L"Guest drive — opened selected file") && InvalidateRect(root,NULL,TRUE));
}
static LRESULT CALLBACK procedure(HWND window,UINT message,WPARAM wp,LPARAM lp) {
    if(message==WM_COMMAND){if((LOWORD(wp)==102 && file_size<=4096)||(LOWORD(wp)==103 && !file_size))return 0;switch(LOWORD(wp)){case 101:write_file();break;case 102:shrink_file();break;case 103:delete_file();break;case 104:open_file();break;}return 0;}
    if(message==WM_PAINT){
        PAINTSTRUCT paint;HDC dc=BeginPaint(window,&paint);CHECK(dc);
        RECT bounds;CHECK(GetClientRect(window,&bounds));CHECK(FillRect(dc,&bounds,(HBRUSH)(COLOR_WINDOW+1)));
        CHECK(SetBkMode(dc,TRANSPARENT));CHECK(TextOutW(dc,20,16,L"C:\\  — browser guest drive",26));
        draw_number(dc,48,L"Total bytes: ",TOTAL_BYTES);draw_number(dc,76,L"Free bytes: ",current_free.QuadPart);draw_number(dc,104,L"Demo file bytes: ",file_size);
        if(selected[0])CHECK(TextOutW(dc,20,144,selected,lstrlenW(selected)));
        CHECK(EndPaint(window,&paint));return 0;
    }
    if(message==WM_DESTROY){if(file_size){CHECK(DeleteFileW(filename));file_size=0;}PostQuitMessage(0);return 0;}
    return DefWindowProcW(window,message,wp,lp);
}
#endif
void start(void) {
    verify();
#ifdef VOLUME_HOST
    ExitProcess(0);
#else
    for(unsigned i=0;i<sizeof(payload);i++)payload[i]=(BYTE)(i&255);
    HINSTANCE module=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.hInstance=module;cls.lpfnWndProc=procedure;cls.lpszClassName=L"NativeGuestDrive";
    CHECK(RegisterClassW(&cls));root=CreateWindowW(cls.lpszClassName,L"Guest drive — ready",WS_OVERLAPPEDWINDOW|WS_VISIBLE,30,40,624,280,NULL,NULL,module,NULL);CHECK(root);
    const WCHAR *labels[]={L"Write 8 KiB",L"Resize to 4 KiB",L"Delete file",L"Open file…"};
    for(unsigned i=0;i<4;i++){controls[i]=CreateWindowW(L"BUTTON",labels[i],WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,20+(int)i*144,186,132,30,root,(HMENU)(UINT_PTR)(101+i),module,NULL);CHECK(controls[i]);}
    EnableWindow(controls[1],FALSE);EnableWindow(controls[2],FALSE);
    MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}ExitProcess((UINT)msg.wParam);
#endif
}
