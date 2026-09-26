#define _WIN32_WINNT 0x0601
#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static unsigned char left[8192], right[8192];
struct comparison { unsigned char *source, *destination; unsigned count, flags; };
#define COMPARE(op) do { \
    if (backward) __asm__ volatile("std; " op "; pushfl; popl %0; cld" : "=a"(flags), "+S"(source), "+D"(destination), "+c"(count) : : "cc", "memory"); \
    else __asm__ volatile("cld; " op "; pushfl; popl %0" : "=a"(flags), "+S"(source), "+D"(destination), "+c"(count) : : "cc", "memory"); \
} while (0)
static struct comparison compare(unsigned width, unsigned repeat, int backward,
                                 unsigned char *source, unsigned char *destination, unsigned count)
{
    unsigned flags;
    if (repeat == 0) {
        if (width == 1) COMPARE("cmpsb");
        else if (width == 2) COMPARE("cmpsw");
        else COMPARE("cmpsl");
    } else if (repeat == 1) {
        if (width == 1) COMPARE("repe cmpsb");
        else if (width == 2) COMPARE("repe cmpsw");
        else COMPARE("repe cmpsl");
    } else {
        if (width == 1) COMPARE("repne cmpsb");
        else if (width == 2) COMPARE("repne cmpsw");
        else COMPARE("repne cmpsl");
    }
    return (struct comparison){source, destination, count, flags};
}
static void put(unsigned char *p, unsigned width, unsigned value)
{
    for (unsigned i = 0; i < width; ++i) p[i] = (unsigned char)(value >> (i * 8));
}
void start(void)
{
    for (unsigned width = 1; width <= 4; width *= 2) {
        /* Signed overflow plus auxiliary borrow, then unsigned borrow. */
        put(left, width, 1u << (width * 8 - 1)); put(right, width, 1);
        struct comparison r = compare(width, 0, 0, left, right, 99);
        CHECK(r.source == left + width && r.destination == right + width && r.count == 99);
        CHECK((r.flags & 0x8d5) == (width == 1 ? 0x810 : 0x814));
        put(left, width, 0); put(right, width, 1);
        r = compare(width, 0, 0, left, right, 99);
        CHECK((r.flags & 0x8d5) == 0x95);
        for (unsigned repeat = 1; repeat <= 2; ++repeat) for (unsigned backward = 0; backward <= 1; ++backward) {
            unsigned initial = backward ? 64 : 0;
            int step = backward ? -(int)width : (int)width;
            for (unsigned i = 0; i < 5; ++i) {
                put(left + initial + i * step, width, 42);
                put(right + initial + i * step, width, ((i == 2) == (repeat == 1)) ? 43 : 42);
            }
            r = compare(width, repeat, backward, left + initial, right + initial, 5);
            CHECK(r.source == left + initial + 3 * step && r.destination == right + initial + 3 * step && r.count == 2);
            CHECK(!!(r.flags & 0x40) == (repeat == 2));
            r = compare(width, repeat, backward, (void *)0xffffffff, (void *)0xffffffff, 0);
            CHECK(r.source == (void *)0xffffffff && r.destination == (void *)0xffffffff && r.count == 0);
        }
    }
    for (unsigned i = 0; i < sizeof(left); ++i) left[i] = right[i] = (unsigned char)(i * 7);
    struct comparison r = compare(1, 1, 0, left, right, 8192);
    CHECK(r.source == left + 8192 && r.destination == right + 8192 && r.count == 0 && (r.flags & 0x40));
    DWORD written;
    CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "cmps-ok\n", 8, &written, NULL) && written == 8);
    ExitProcess(0);
}
