/* SPDX-License-Identifier: MIT
 * Minimal build-time wrapper around Wine's LGPL d3dcompiler_47 implementation.
 */
#define COBJMACROS
#include <d3dcompiler.h>
#include <stdio.h>
#include <stdlib.h>

static int write_blob(const char *path, ID3DBlob *blob)
{
    FILE *file = fopen(path, "wb");
    size_t size = ID3D10Blob_GetBufferSize(blob);
    int ok = file && fwrite(ID3D10Blob_GetBufferPointer(blob), 1, size, file) == size;
    if (file) fclose(file);
    return ok;
}

int main(int argc, char **argv)
{
    ID3DBlob *code = NULL, *messages = NULL;
    unsigned char *source;
    long length;
    HRESULT hr;
    FILE *file;

    if (argc != 5)
    {
        fprintf(stderr, "usage: compile-dxbc SOURCE ENTRY TARGET OUTPUT\n");
        return 2;
    }
    if (!(file = fopen(argv[1], "rb")) || fseek(file, 0, SEEK_END)
            || (length = ftell(file)) < 0 || length > 1024 * 1024
            || fseek(file, 0, SEEK_SET) || !(source = malloc(length ? length : 1))
            || fread(source, 1, length, file) != (size_t)length)
    {
        fprintf(stderr, "cannot read bounded source %s\n", argv[1]);
        if (file) fclose(file);
        return 2;
    }
    fclose(file);
    hr = D3DCompile(source, length, argv[1], NULL, NULL, argv[2], argv[3],
            D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3, 0,
            &code, &messages);
    free(source);
    if (messages)
    {
        fwrite(ID3D10Blob_GetBufferPointer(messages), 1,
                ID3D10Blob_GetBufferSize(messages), stderr);
        ID3D10Blob_Release(messages);
    }
    if (FAILED(hr) || !code)
    {
        fprintf(stderr, "D3DCompile failed: %#lx\n", (unsigned long)hr);
        return 1;
    }
    if (!write_blob(argv[4], code))
    {
        fprintf(stderr, "cannot write %s\n", argv[4]);
        ID3D10Blob_Release(code);
        return 2;
    }
    ID3D10Blob_Release(code);
    return 0;
}
