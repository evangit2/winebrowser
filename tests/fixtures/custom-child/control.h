#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(__LINE__ + 1000); } while (0)
typedef struct { HWND root; COLORREF color; unsigned flags; } CANVAS_CONTEXT;
#define CONTROL_CLASS "NativeDllCanvas"
#define TEST_MESSAGE (WM_APP+10)
