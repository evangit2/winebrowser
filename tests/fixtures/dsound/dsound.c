#define COBJMACROS
#define DIRECTSOUND_VERSION 0x0800
#include <windows.h>
#include <dsound.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
void *memset(void *target, int value, size_t size)
{
    volatile unsigned char *bytes = target;
    while (size--) *bytes++ = (unsigned char)value;
    return target;
}
static void phase(const char *text, DWORD size)
{
    DWORD written;
    CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, size, &written, NULL));
}
#define PHASE(text) phase(text "\n", sizeof(text))
static unsigned enumerated;
static BOOL CALLBACK enumerate(GUID *guid, const WCHAR *description, const WCHAR *driver, void *context)
{
    CHECK(description && description[0] && driver && driver[0] && context == (void *)1234);
    CHECK((!enumerated && !guid) || (enumerated && guid));
    enumerated++;
    return TRUE;
}
void start(void)
{
    HMODULE dll = LoadLibraryA("dsound.dll");
    CHECK(dll);
    CHECK(GetProcAddress(dll, (const char *)1) == GetProcAddress(dll, "DirectSoundCreate"));
    CHECK(GetProcAddress(dll, (const char *)11) == GetProcAddress(dll, "DirectSoundCreate8"));
    CHECK(DirectSoundEnumerateW(enumerate, (void *)1234) == DS_OK && enumerated == 2);
    IDirectSound8 *sound;
    typedef HRESULT (WINAPI *CREATE)(const GUID *, IDirectSound8 **, IUnknown *);
    CREATE create = (CREATE)(void *)GetProcAddress(dll, (const char *)11);
    CHECK(create(NULL, &sound, NULL) == DS_OK);
    CHECK(IDirectSound8_SetCooperativeLevel(sound, GetDesktopWindow(), DSSCL_PRIORITY) == DS_OK);
    DWORD certified;
    CHECK(IDirectSound8_VerifyCertification(sound, &certified) == DS_OK && certified == DS_UNCERTIFIED);
    DSCAPS caps = {0}; caps.dwSize = sizeof(caps);
    CHECK(IDirectSound8_GetCaps(sound, &caps) == DS_OK && caps.dwPrimaryBuffers == 1 && !caps.dwMaxHwMixingAllBuffers);
    DSBUFFERDESC desc = {0}; desc.dwSize = sizeof(desc); desc.dwFlags = DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME;
    IDirectSoundBuffer *primary, *buffer, *copy;
    CHECK(IDirectSound8_CreateSoundBuffer(sound, &desc, &primary, NULL) == DS_OK);
    WAVEFORMATEX output = {WAVE_FORMAT_PCM, 2, 44100, 176400, 4, 16, 0};
    CHECK(IDirectSoundBuffer_SetFormat(primary, &output) == DS_OK);
    WAVEFORMATEX mono = {WAVE_FORMAT_PCM, 1, 8000, 8000, 1, 8, 0};
    desc.dwFlags = DSBCAPS_CTRLVOLUME | DSBCAPS_CTRLPAN | DSBCAPS_CTRLFREQUENCY | DSBCAPS_GLOBALFOCUS | DSBCAPS_GETCURRENTPOSITION2;
    desc.dwBufferBytes = 1600; desc.lpwfxFormat = &mono;
    CHECK(IDirectSound8_CreateSoundBuffer(sound, &desc, &buffer, NULL) == DS_OK);
    IDirectSoundBuffer8 *buffer8;
    CHECK(IDirectSoundBuffer_QueryInterface(buffer, &IID_IDirectSoundBuffer8, (void **)&buffer8) == DS_OK);
    CHECK((void *)buffer8 == (void *)buffer); IDirectSoundBuffer8_Release(buffer8);
    void *first, *second; DWORD first_size, second_size;
    CHECK(IDirectSoundBuffer_Lock(buffer, 0, 0, &first, &first_size, &second, &second_size, DSBLOCK_ENTIREBUFFER) == DS_OK);
    CHECK(first && first_size == 1600 && !second && !second_size);
    for (unsigned i = 0; i < first_size; i++) ((BYTE *)first)[i] = (i & 16) ? 64 : 192;
    CHECK(IDirectSoundBuffer_Unlock(buffer, first, first_size, second, second_size) == DS_OK);
    CHECK(IDirectSoundBuffer_Lock(buffer, 1590, 20, &first, &first_size, &second, &second_size, 0) == DS_OK);
    CHECK(first_size == 10 && second_size == 10 && (BYTE *)first == (BYTE *)second + 1590);
    CHECK(IDirectSoundBuffer_Unlock(buffer, first, first_size, second, second_size) == DS_OK);
    CHECK(IDirectSound8_DuplicateSoundBuffer(sound, buffer, &copy) == DS_OK);
    PHASE("mono-loop");
    CHECK(IDirectSoundBuffer_Play(buffer, 0, 0, DSBPLAY_LOOPING) == DS_OK);
    Sleep(250);
    DWORD play, write, status;
    CHECK(IDirectSoundBuffer_GetStatus(buffer, &status) == DS_OK && status == (DSBSTATUS_PLAYING | DSBSTATUS_LOOPING));
    CHECK(IDirectSoundBuffer_GetCurrentPosition(buffer, &play, &write) == DS_OK && play < 1600 && write < 1600 && play != write);
    PHASE("quiet-right");
    CHECK(IDirectSoundBuffer_SetVolume(buffer, -2000) == DS_OK);
    CHECK(IDirectSoundBuffer_SetPan(buffer, DSBPAN_RIGHT) == DS_OK);
    CHECK(IDirectSoundBuffer_SetFrequency(buffer, 16000) == DS_OK);
    Sleep(250);
    CHECK(IDirectSoundBuffer_Stop(buffer) == DS_OK);
    CHECK(IDirectSoundBuffer_GetCurrentPosition(buffer, &play, &write) == DS_OK && play == write);
    Sleep(100);
    DWORD stopped;
    CHECK(IDirectSoundBuffer_GetCurrentPosition(buffer, &stopped, NULL) == DS_OK && stopped == play);
    CHECK(IDirectSoundBuffer_SetFrequency(buffer, DSBFREQUENCY_ORIGINAL) == DS_OK);
    CHECK(IDirectSoundBuffer_SetVolume(buffer, 0) == DS_OK);
    CHECK(IDirectSoundBuffer_SetPan(buffer, 0) == DS_OK);
    CHECK(IDirectSoundBuffer_SetCurrentPosition(buffer, 0) == DS_OK);
    PHASE("one-shot");
    CHECK(IDirectSoundBuffer_Play(buffer, 0, 0, 0) == DS_OK);
    Sleep(350);
    CHECK(IDirectSoundBuffer_GetStatus(buffer, &status) == DS_OK && !status);
    CHECK(IDirectSoundBuffer_GetCurrentPosition(buffer, &play, &write) == DS_OK && !play && !write);
    CHECK(IDirectSoundBuffer_Lock(copy, 0, 0, &first, &first_size, &second, &second_size, DSBLOCK_ENTIREBUFFER) == DS_OK);
    CHECK(first_size == 1600 && ((BYTE *)first)[0] == 192);
    CHECK(IDirectSoundBuffer_Unlock(copy, first, first_size, second, second_size) == DS_OK);
    CHECK(IDirectSoundBuffer_Release(buffer) == 0);
    PHASE("duplicate-loop-exit");
    CHECK(IDirectSoundBuffer_Play(copy, 0, 0, DSBPLAY_LOOPING) == DS_OK);
    Sleep(250);
    // Exit with a live looping buffer to exercise process audio cleanup.
    ExitProcess(0);
}
