/* Original WineBrowser contributors, MIT. Native output-handle alias probe. */
#include <windows.h>
#include <stdio.h>
#include <winternl.h>
typedef LONG (WINAPI *NtIoctl)(HANDLE,HANDLE,void*,void*,PIO_STATUS_BLOCK,ULONG,void*,ULONG,void*,ULONG);
typedef LONG (WINAPI *NtDuplicate)(HANDLE,HANDLE,HANDLE,PHANDLE,ACCESS_MASK,ULONG,ULONG);
int main(void){
 HANDLE process=GetCurrentProcess(), original=GetStdHandle(STD_OUTPUT_HANDLE), first=NULL, second=NULL, limited=NULL;
 DWORD count=0, flags=0; char rows[4096]; int n=0;
 NtDuplicate duplicate=(NtDuplicate)GetProcAddress(GetModuleHandleA("ntdll.dll"),"NtDuplicateObject");
 LONG status=duplicate(process,original,process,&first,0,2,2);
 BOOL info=GetHandleInformation(first,&flags);
 NtIoctl ioctl=(NtIoctl)GetProcAddress(GetModuleHandleA("ntdll.dll"),"NtDeviceIoControlFile");
 IO_STATUS_BLOCK io; io.Status=0x12345678;io.Information=0x12345678;DWORD mode=0x12345678;
 LONG ioctlStatus=ioctl(first,NULL,NULL,NULL,&io,0x00504000,NULL,0,&mode,4);
 FILE *device=fopen("native-device.json","wb");if(!device)return 3;
 fprintf(device,"{\"status\":%lu,\"iosb\":%lu,\"information\":%lu,\"mode\":%lu}\n",(DWORD)ioctlStatus,(DWORD)io.Status,(DWORD)io.Information,mode);fclose(device);
 n+=sprintf(rows+n,"{\"duplicateStatus\":%lu,\"inherit\":%lu,\"info\":%d",(DWORD)status,flags,info);
 BOOL ok=WriteFile(first,"A",1,&count,NULL);
 n+=sprintf(rows+n,",\"writeFirst\":%d,\"countFirst\":%lu",ok,count);
 status=duplicate(process,first,process,&second,0,0,6);GetHandleInformation(second,&flags);
 n+=sprintf(rows+n,",\"cascadeStatus\":%lu,\"cascadeFlags\":%lu",(DWORD)status,flags);
 status=duplicate(process,original,process,&limited,0,0,0);
 SetLastError(777);count=99;ok=WriteFile(limited,"X",1,&count,NULL);DWORD error=GetLastError();
 n+=sprintf(rows+n,",\"limitedStatus\":%lu,\"limitedWrite\":%d,\"limitedError\":%lu,\"limitedCount\":%lu",(DWORD)status,ok,error,count);
 CloseHandle(limited); CloseHandle(original); CloseHandle(first);
 count=0;ok=WriteFile(second,"B",1,&count,NULL);
 n+=sprintf(rows+n,",\"writeAfterOriginalClose\":%d,\"countAfterOriginalClose\":%lu",ok,count);
 CloseHandle(second); SetLastError(777);count=99;ok=WriteFile(second,"X",1,&count,NULL);error=GetLastError();
 n+=sprintf(rows+n,",\"closedWrite\":%d,\"closedError\":%lu,\"closedCount\":%lu}\n",ok,error,count);
 FILE *report=fopen("native-output.json","wb");if(!report)return 2;fwrite(rows,1,n,report);fclose(report);return 0;
}
