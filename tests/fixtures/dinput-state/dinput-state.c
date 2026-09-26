#define COBJMACROS
#define DIRECTINPUT_VERSION 0x0800
#include <windows.h>
#include <dinput.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
void *memset(void *target, int value, size_t size)
{ volatile unsigned char *bytes = target; while (size--) *bytes++ = (unsigned char)value; return target; }
static IDirectInput8A *input;
static IDirectInputDevice8A *keyboard, *mouse;
static unsigned int stage;
static LONG dx, dy, wheel;
static unsigned int mouse_down, mouse_up, wheel_events;
static void flush(IDirectInputDevice8A *device)
{ DWORD count = INFINITE; CHECK(IDirectInputDevice8_GetDeviceData(device, sizeof(DIDEVICEOBJECTDATA), NULL, &count, 0) == DI_OK); }
static void keyboard_events(unsigned int down)
{
    DIDEVICEOBJECTDATA events[4]; DWORD count = 4;
    CHECK(IDirectInputDevice8_GetDeviceData(keyboard, sizeof(events[0]), events, &count, DIGDD_PEEK) == DI_OK);
    CHECK(count == 2 && events[0].dwOfs == DIK_A && events[1].dwOfs == DIK_RCONTROL);
    CHECK(events[0].dwData == down && events[1].dwData == down && events[1].dwSequence > events[0].dwSequence);
    count = 4;
    CHECK(IDirectInputDevice8_GetDeviceData(keyboard, sizeof(events[0]), events, &count, 0) == DI_OK && count == 2);
}
static LRESULT CALLBACK proc(HWND window, UINT message, WPARAM wp, LPARAM lp)
{
    if (message == WM_KEYDOWN && wp == VK_ESCAPE) { CHECK(stage == 6); PostQuitMessage(0); return 0; }
    if (message == WM_TIMER) {
        BYTE keys[256]; DIMOUSESTATE2 state;
        HRESULT kr = IDirectInputDevice8_GetDeviceState(keyboard, sizeof(keys), keys);
        HRESULT mr = IDirectInputDevice8_GetDeviceState(mouse, sizeof(state), &state);
        if (stage == 4 && kr == DIERR_NOTACQUIRED && mr == DIERR_NOTACQUIRED) {
            CHECK(IDirectInputDevice8_Acquire(keyboard) == DIERR_OTHERAPPHASPRIO);
            stage = 5; SetWindowTextA(window, "Input lost"); return 0;
        }
        if (stage == 5) {
            if (IDirectInputDevice8_Acquire(keyboard) == DI_OK) {
                CHECK(IDirectInputDevice8_Acquire(mouse) == DI_OK);
                CHECK(IDirectInputDevice8_GetDeviceState(keyboard, sizeof(keys), keys) == DI_OK && !keys[DIK_B]);
                stage = 6; SetWindowTextA(window, "Input reacquired");
            }
            return 0;
        }
        CHECK(kr == DI_OK && mr == DI_OK);
        CHECK(!state.rgbButtons[5] && !state.rgbButtons[6] && !state.rgbButtons[7]);
        if (stage == 0 && keys[DIK_A] && keys[DIK_RCONTROL]) {
            CHECK(keys[DIK_A] == 128 && keys[DIK_RCONTROL] == 128 && !keys[DIK_LCONTROL]);
            keyboard_events(128); stage = 1; SetWindowTextA(window, "Keys down");
        } else if (stage == 1 && !keys[DIK_A] && !keys[DIK_RCONTROL]) {
            keyboard_events(0); stage = 2; flush(mouse); SetWindowTextA(window, "Keys released");
        } else if (stage == 2) {
            dx += state.lX; dy += state.lY;
            if (state.rgbButtons[1]) {
                CHECK(dx == 24 && dy == 12 && state.rgbButtons[1] == 128 && !state.rgbButtons[0]);
                stage = 3; SetWindowTextA(window, "Mouse down");
            }
        } else if (stage == 3) {
            DIDEVICEOBJECTDATA events[32]; DWORD count = 32;
            CHECK(IDirectInputDevice8_GetDeviceData(mouse, sizeof(events[0]), events, &count, 0) == DI_OK);
            for (DWORD i = 0; i < count; i++) {
                if (events[i].dwOfs == DIMOFS_BUTTON1) { if (events[i].dwData) mouse_down++; else mouse_up++; }
                if (events[i].dwOfs == DIMOFS_Z) { CHECK((LONG)events[i].dwData == -120); wheel_events++; }
            }
            wheel += state.lZ;
            if (!state.rgbButtons[1] && wheel) {
                CHECK(wheel == -120 && mouse_down == 1 && mouse_up == 1 && wheel_events == 1);
                stage = 4; SetWindowTextA(window, "Input verified");
            }
        }
        return 0;
    }
    return DefWindowProcA(window, message, wp, lp);
}
void start(void)
{
    HINSTANCE instance = GetModuleHandleA(NULL);
    WNDCLASSA cls = {0}; cls.lpfnWndProc = proc; cls.hInstance = instance; cls.lpszClassName = "NativeDirectInputState";
    CHECK(RegisterClassA(&cls));
    HWND window = CreateWindowExA(0, cls.lpszClassName, "Input starting", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
        20, 20, 360, 260, NULL, NULL, instance, NULL);
    CHECK(window); SetFocus(window);
    CHECK(DirectInput8Create(instance, 0x800, &IID_IDirectInput8A, (void **)&input, NULL) == DI_OK);
    CHECK(IDirectInput8_CreateDevice(input, &GUID_SysKeyboard, &keyboard, NULL) == DI_OK);
    CHECK(IDirectInput8_CreateDevice(input, &GUID_SysMouse, &mouse, NULL) == DI_OK);
    CHECK(IDirectInputDevice8_SetDataFormat(keyboard, &c_dfDIKeyboard) == DI_OK);
    CHECK(IDirectInputDevice8_SetDataFormat(mouse, &c_dfDIMouse2) == DI_OK);
    CHECK(IDirectInputDevice8_SetCooperativeLevel(keyboard, window, DISCL_NONEXCLUSIVE | DISCL_FOREGROUND) == DI_OK);
    CHECK(IDirectInputDevice8_SetCooperativeLevel(mouse, window, DISCL_NONEXCLUSIVE | DISCL_FOREGROUND) == DI_OK);
    DIPROPDWORD buffer = {{sizeof(buffer), sizeof(buffer.diph), 0, DIPH_DEVICE}, 64};
    CHECK(IDirectInputDevice8_SetProperty(keyboard, DIPROP_BUFFERSIZE, &buffer.diph) == DI_OK);
    CHECK(IDirectInputDevice8_SetProperty(mouse, DIPROP_BUFFERSIZE, &buffer.diph) == DI_OK);
    CHECK(IDirectInputDevice8_Acquire(keyboard) == DI_OK && IDirectInputDevice8_Acquire(mouse) == DI_OK);
    CHECK(SetTimer(window, 1, 20, NULL));
    SetWindowTextA(window, "Input ready");
    MSG message;
    while (GetMessageA(&message, NULL, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageA(&message); }
    KillTimer(window, 1);
    CHECK(IDirectInputDevice8_Unacquire(mouse) == DI_OK && IDirectInputDevice8_Unacquire(keyboard) == DI_OK);
    CHECK(IDirectInputDevice8_Release(mouse) == 0 && IDirectInputDevice8_Release(keyboard) == 0);
    CHECK(IDirectInput8_Release(input) == 0);
    CHECK(DestroyWindow(window)); ExitProcess(0);
}
