#define COBJMACROS
#define DIRECTINPUT_VERSION 0x0800
#include <windows.h>
#include <dinput.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
void *memset(void *target, int value, size_t size)
{
    volatile unsigned char *bytes = target;
    while (size--) *bytes++ = (unsigned char)value;
    return target;
}
static unsigned int enumerated, stop_after_one;
static IDirectInput8A *input;
static BOOL CALLBACK device_callback(const DIDEVICEINSTANCEA *info, void *context)
{
    CHECK(context == (void *)0x12345678);
    CHECK(info->dwSize == sizeof(*info) && info->tszInstanceName[0]);
    CHECK(IDirectInput8_GetDeviceStatus(input, &info->guidInstance) == DI_OK);
    IDirectInputDevice8A *device;
    CHECK(IDirectInput8_CreateDevice(input, &info->guidInstance, &device, NULL) == DI_OK);
    DIDEVCAPS caps = {0}; caps.dwSize = sizeof(caps);
    CHECK(IDirectInputDevice8_GetCapabilities(device, &caps) == DI_OK);
    CHECK((caps.dwFlags & DIDC_ATTACHED) && !(caps.dwFlags & DIDC_FORCEFEEDBACK));
    CHECK(caps.dwDevType == info->dwDevType && caps.dwButtons && !caps.dwPOVs);
    if (GET_DIDEVICE_TYPE(info->dwDevType) == DI8DEVTYPE_MOUSE) CHECK(caps.dwAxes == 3);
    else CHECK(GET_DIDEVICE_TYPE(info->dwDevType) == DI8DEVTYPE_KEYBOARD && !caps.dwAxes);
    IDirectInputDevice8W *wide;
    CHECK(IDirectInputDevice8_QueryInterface(device, &IID_IDirectInputDevice8W, (void **)&wide) == DI_OK);
    DIDEVICEINSTANCEW details = {0}; details.dwSize = sizeof(details);
    CHECK(IDirectInputDevice8_GetDeviceInfo(wide, &details) == DI_OK);
    CHECK(details.dwDevType == info->dwDevType && details.tszInstanceName[0] == info->tszInstanceName[0]);
    IUnknown *identity_a, *identity_w;
    CHECK(IDirectInputDevice8_QueryInterface(device, &IID_IUnknown, (void **)&identity_a) == DI_OK);
    CHECK(IDirectInputDevice8_QueryInterface(wide, &IID_IUnknown, (void **)&identity_w) == DI_OK);
    CHECK(identity_a == identity_w);
    IUnknown_Release(identity_a); IUnknown_Release(identity_w);
    CHECK(IDirectInputDevice8_Release(wide) == 1);
    CHECK(IDirectInputDevice8_Release(device) == 0);
    enumerated++;
    return !stop_after_one;
}
void start(void)
{
    HINSTANCE instance = GetModuleHandleA(NULL);
    CHECK(DirectInput8Create(instance, 0x800, &IID_IDirectInput8A, NULL, NULL) == E_POINTER);
    CHECK(DirectInput8Create(instance, 0x700, &IID_IDirectInput8A, (void **)&input, NULL) == DIERR_BETADIRECTINPUTVERSION && !input);
    CHECK(DirectInput8Create(instance, 0x801, &IID_IDirectInput8A, (void **)&input, NULL) == DIERR_OLDDIRECTINPUTVERSION && !input);
    CHECK(DirectInput8Create(instance, 0x800, &IID_IDirectInput8A, (void **)&input, NULL) == DI_OK);
    IDirectInput8W *wide;
    CHECK(IDirectInput8_QueryInterface(input, &IID_IDirectInput8W, (void **)&wide) == DI_OK);
    CHECK(IDirectInput8_Initialize(wide, instance, 0x800) == DI_OK);
    CHECK(IDirectInput8_Release(wide) == 1);
    CHECK(IDirectInput8_EnumDevices(input, DI8DEVCLASS_ALL, device_callback, (void *)0x12345678, DIEDFL_ATTACHEDONLY) == DI_OK);
    CHECK(enumerated == 2);
    enumerated = 0; stop_after_one = 1;
    CHECK(IDirectInput8_EnumDevices(input, DI8DEVCLASS_ALL, device_callback, (void *)0x12345678, 0) == DI_OK && enumerated == 1);
    enumerated = 0; stop_after_one = 0;
    CHECK(IDirectInput8_EnumDevices(input, DI8DEVCLASS_GAMECTRL, device_callback, (void *)0x12345678, 0) == DI_OK && !enumerated);
    CHECK(IDirectInput8_EnumDevices(input, DI8DEVCLASS_ALL, device_callback, (void *)0x12345678, DIEDFL_FORCEFEEDBACK) == DI_OK && !enumerated);
    IDirectInputDevice8A *device = (void *)0xdeadbeef;
    CHECK(IDirectInput8_CreateDevice(input, &GUID_Joystick, &device, NULL) == DIERR_DEVICENOTREG && !device);
    CHECK(IDirectInput8_GetDeviceStatus(input, &GUID_Joystick) == DIERR_DEVICENOTREG);
    CHECK(IDirectInput8_Release(input) == 0);
    ExitProcess(0);
}
