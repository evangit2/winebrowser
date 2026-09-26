#define COBJMACROS
#include <windows.h>
#include <d3dcompiler.h>
#define CHECK(c) do { if (!(c)) ExitProcess(__LINE__); } while(0)
static const char pixel[] = "float4 main() : SV_TARGET { return float4(1,0,0,1); }";
void start(void) {
 ID3DBlob *vs=0, *ps=0, *errors=(ID3DBlob*)1, *bad=0;
 CHECK(D3DCompileFromFile(L"shaders.hlsl",0,0,"VSMain","vs_5_0",0,0,&vs,&errors)==S_OK);
 CHECK(vs && !errors);
 CHECK(ID3D10Blob_GetBufferSize(vs)>32);
 CHECK(*(DWORD*)ID3D10Blob_GetBufferPointer(vs)==0x43425844);
 void *saved=ID3D10Blob_GetBufferPointer(vs);
 CHECK(D3DCompile(pixel,sizeof(pixel)-1,"inline.hlsl",0,0,"main","ps_5_0",0,123,&ps,0)==S_OK);
 CHECK(ps && ps!=vs && ID3D10Blob_GetBufferSize(ps)>32);
 CHECK(ID3D10Blob_GetBufferPointer(vs)==saved && *(DWORD*)saved==0x43425844);
 CHECK(ID3D10Blob_AddRef(vs)==2 && ID3D10Blob_Release(vs)==1);
 CHECK(D3DCompile("invalid",7,0,0,0,"main","ps_5_0",0,0,&bad,&errors)==E_FAIL);
 CHECK(!bad && errors && ID3D10Blob_GetBufferSize(errors)>1);
 char *message=ID3D10Blob_GetBufferPointer(errors);
 CHECK(message[ID3D10Blob_GetBufferSize(errors)-1]==0);
 CHECK(ID3D10Blob_Release(errors)==0);errors=0;
 CHECK(D3DCompileFromFile(L"missing.hlsl",0,0,"VSMain","vs_5_0",0,0,&bad,&errors)==HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND));
 CHECK(!bad && errors);CHECK(ID3D10Blob_Release(errors)==0);errors=0;
 CHECK(D3DCompileFromFile(L"shaders.hlsl",0,0,"VSMain","vs_6_0",0,0,&bad,&errors)==E_NOTIMPL);
 CHECK(!bad && errors);CHECK(ID3D10Blob_Release(errors)==0);errors=0;
 CHECK(D3DCompile(pixel,sizeof(pixel)-1,0,0,0,"main","ps_5_0",0,0,0,0)==E_INVALIDARG);
 CHECK(D3DCompileFromFile(L"shaders.hlsl",0,0,"PSMain","ps_5_0",0,0,&bad,&errors)==S_OK);
 CHECK(bad && !errors);CHECK(ID3D10Blob_Release(bad)==0);
 CHECK(ID3D10Blob_Release(vs)==0 && ID3D10Blob_Release(ps)==0);
 DWORD written;
 CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),"hlsl-ok\n",8,&written,0)&&written==8);
 ExitProcess(0);
}
