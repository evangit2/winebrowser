/* A native PE32 fixture that installs a real SEH chain at fs:[0], faults on an
 * unmapped address, and reports what its filter observed in the delivered
 * EXCEPTION_RECORD and CONTEXT. It also exercises RtlUnwind, the mechanism an
 * MSVC __except body uses to leave the handler frame.
 *
 * The chain is built by hand with the documented i386 ABI so the fixture has no
 * dependence on any particular compiler's SEH runtime. */
#include <windows.h>
#include <stdint.h>

/* EXCEPTION_EXECUTE_HANDLER and the continue codes come from excpt.h. */

typedef struct registration {
    struct registration *next;
    /* The registered handler is __cdecl (excpt.h declares _except_handler as
     * __cdecl); the runtime calls it and the caller cleans the arguments. */
    int (__cdecl *handler)(void *record, void *frame, void *context, void *dispatcher);
} registration;

/* DWORDs the filter records so the harness can check the delivered structures. */
static volatile uint32_t record_code;
static volatile uint32_t record_address;
static volatile uint32_t record_parameters;
static volatile uint32_t context_eip;
static volatile uint32_t context_esp;
static volatile uint32_t handler_calls;
static volatile int unwind_occurred;
static registration frame;

static int __cdecl filter(void *record, void *context_frame, void *context, void *dispatcher)
{
    const uint32_t *rec = record;
    const uint8_t *ctx = context;
    const uint32_t flags = rec[1];
    (void)context_frame; (void)dispatcher;

    if (flags & 0x2) {
        /* EXCEPTION_UNWINDING: this call is the unwind walk, not the search. */
        unwind_occurred = 1;
        return ExceptionContinueSearch;
    }
    handler_calls++;
    record_code = rec[0];
    record_parameters = rec[4];
    record_address = rec[6];
    context_eip = *(const uint32_t *)(ctx + 0xb8);
    context_esp = *(const uint32_t *)(ctx + 0xc4);
    /* Repair the fault: skip the faulting `mov eax,[addr]` (5 bytes) and give
     * EAX a defined value, exactly as a guard-page probe handler would. A frame
     * handler reports "handled" with the ExceptionContinueExecution
     * disposition, which is 0. */
    *(uint32_t *)(ctx + 0xb8) = context_eip + 5;
    *(uint32_t *)(ctx + 0xb0) = 0xfeedface;
    return ExceptionContinueExecution;
}

static void console_write(const char *text)
{
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, 0);
}

static void write_hex(uint32_t value)
{
    char buffer[11];
    buffer[0] = '0'; buffer[1] = 'x';
    for (int i = 0; i < 8; i++) {
        const uint32_t nibble = (value >> ((7 - i) * 4)) & 0xf;
        buffer[2 + i] = (char)(nibble < 10 ? '0' + nibble : 'a' + nibble - 10);
    }
    buffer[10] = 0;
    console_write(buffer);
}

void mainCRTStartup(void)
{
    /* Push our own frame onto the TEB chain, remembering the previous head. */
    __asm__ volatile ("movl %%fs:0, %0" : "=r"(frame.next));
    frame.handler = filter;
    __asm__ volatile ("movl %0, %%fs:0" :: "r"(&frame));

    console_write("before\r\n");
    /* Read an unmapped address. The runtime offers the resulting fault to the
     * chain above; our filter accepts it. */
    volatile uint32_t *bad = (volatile uint32_t *)0x7fff0000;
    (void)*bad;
    console_write("after\r\n");

    console_write("handler_calls=");
    write_hex(handler_calls);
    console_write("\r\n");
    console_write("code=");
    write_hex(record_code);
    console_write("\r\n");
    console_write("address=");
    write_hex(record_address);
    console_write("\r\n");
    console_write("parameters=");
    write_hex(record_parameters);
    console_write("\r\n");
    console_write("eip=");
    write_hex(context_eip);
    console_write("\r\n");
    console_write("unwound=");
    write_hex((uint32_t)unwind_occurred);
    console_write("\r\n");

    __asm__ volatile ("movl %0, %%fs:0" :: "r"(frame.next));
    ExitProcess(0);
}
