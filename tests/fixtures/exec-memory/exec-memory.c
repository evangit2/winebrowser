/* A native PE32 fixture for private executable memory.
 *
 * It performs what a packer, a loader stub or a tiny JIT does: reserve and
 * commit private memory with PAGE_EXECUTE_READWRITE, emit machine code into it,
 * drop write access with PAGE_EXECUTE_READ, and call the code. The generated
 * routine returns a value computed from its argument, so a call that actually
 * executes the emitted bytes is distinguishable from one that does not.
 *
 * A second pass makes the same pages writable again, replaces the emitted
 * bytes, and calls the new version. That is the self-modifying case: the
 * runtime must notice the protection change and the rewritten code instead of
 * re-running its earlier translation. */
#include <windows.h>
#include <stdint.h>

static void console_write(const char *text)
{
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, 0);
}

static void write_hex(uint32_t value)
{
    static const char digits[] = "0123456789abcdef";
    char buffer[11];
    buffer[0] = '0';
    buffer[1] = 'x';
    for (int i = 0; i < 8; i++) buffer[2 + i] = digits[(value >> ((7 - i) * 4)) & 0xf];
    buffer[10] = 0;
    console_write(buffer);
}

/* add_value(x) = x + k, stdcall: the callee pops its argument. */
static uint32_t __stdcall add_value(uint32_t x)
{
    return x + 100;
}

void mainCRTStartup(void)
{
    DWORD old = 0;
    /* mov eax,[esp+4]; add eax,<immediate>; ret 4 — a complete stdcall routine
     * that reads its argument off the stack, adds a constant and pops it. */
    unsigned char code[12] = {
        0x8b, 0x44, 0x24, 0x04,             /* mov eax,[esp+4] */
        0x05, 0x00, 0x00, 0x00, 0x00,       /* add eax,imm32 */
        0xc2, 0x04, 0x00,                   /* ret 4 */
    };
    code[5] = (unsigned char)(add_value(0) & 0xff);

    void *block = VirtualAlloc(0, 0x1000, MEM_RESERVE | MEM_COMMIT, PAGE_EXECUTE_READWRITE);
    if (!block) {
        console_write("alloc=failed\r\n");
        ExitProcess(1);
    }
    unsigned char *bytes = (unsigned char *)block;
    for (int i = 0; i < (int)sizeof(code); i++) bytes[i] = code[i];

    /* The bytes are final, so drop write access: PAGE_EXECUTE_READ. */
    if (!VirtualProtect(block, 0x1000, PAGE_EXECUTE_READ, &old)) {
        console_write("protect=failed\r\n");
        ExitProcess(1);
    }
    console_write("old=");
    write_hex(old);
    console_write("\r\n");

    uint32_t (*generated)(uint32_t) = (uint32_t (*)(uint32_t))block;
    uint32_t first = generated(1);
    console_write("first=");
    write_hex(first);
    console_write("\r\n");

    /* Make it writable again and replace the emitted constant with +200. */
    if (!VirtualProtect(block, 0x1000, PAGE_EXECUTE_READWRITE, &old)) {
        console_write("rewrite-protect=failed\r\n");
        ExitProcess(1);
    }
    bytes[5] = (unsigned char)(200 & 0xff);
    if (!VirtualProtect(block, 0x1000, PAGE_EXECUTE_READ, &old)) {
        console_write("restore-protect=failed\r\n");
        ExitProcess(1);
    }
    uint32_t second = generated(1);
    console_write("second=");
    write_hex(second);
    console_write("\r\n");

    if (!VirtualFree(block, 0, MEM_RELEASE)) {
        console_write("free=failed\r\n");
        ExitProcess(1);
    }
    console_write("freed=1\r\n");
    ExitProcess(0);
}
