#include <windows.h>
#include <mmsystem.h>

_Static_assert(sizeof(MIXERLINEA) == 168, "PE32 ANSI line ABI");
_Static_assert(sizeof(MIXERLINEW) == 280, "PE32 UTF16 line ABI");
_Static_assert(sizeof(MIXERCONTROLA) == 148, "PE32 ANSI control ABI");
_Static_assert(sizeof(MIXERCONTROLW) == 228, "PE32 UTF16 control ABI");
_Static_assert(sizeof(MIXERLINECONTROLSA) == 24, "PE32 control query ABI");
_Static_assert(sizeof(MIXERCONTROLDETAILS) == 24, "PE32 details ABI");
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)

static MIXERCAPSA caps;
static MIXERLINEA line;
static MIXERLINEW wide_line;
static MIXERCONTROLA controls[2];
static MIXERCONTROLW wide_control;
static MIXERLINECONTROLSA query;
static MIXERLINECONTROLSW wide_query;
static MIXERCONTROLDETAILS details;
static DWORD value;
static TIMECAPS timecaps;
static MMTIME mmtime;

void start(void)
{
    HMIXER mixer;
    UINT id = 99;
    CHECK(timeGetDevCaps(&timecaps, sizeof(timecaps)) == TIMERR_NOERROR);
    CHECK(timecaps.wPeriodMin == 1 && timecaps.wPeriodMax == 1000);
    CHECK(timeBeginPeriod(1) == TIMERR_NOERROR);
    CHECK(timeGetSystemTime(&mmtime, sizeof(mmtime)) == TIMERR_NOERROR);
    CHECK(mmtime.wType == TIME_MS && (DWORD)(timeGetTime() - mmtime.u.ms) < 1000);
    CHECK(timeEndPeriod(1) == TIMERR_NOERROR);
    CHECK(mixerGetNumDevs() == 1);
    CHECK(mixerGetDevCapsA(0, &caps, sizeof(caps)) == MMSYSERR_NOERROR);
    CHECK(caps.cDestinations == 1 && caps.szPname[0] == 'W');
    CHECK(mixerOpen(&mixer, 0, 0, 0, 0) == MMSYSERR_NOERROR);
    CHECK(mixerGetID((HMIXEROBJ)mixer, &id, MIXER_OBJECTF_HMIXER) == MMSYSERR_NOERROR && id == 0);
    line.cbStruct = sizeof(line);
    line.dwComponentType = MIXERLINE_COMPONENTTYPE_DST_SPEAKERS;
    CHECK(mixerGetLineInfoA((HMIXEROBJ)mixer, &line,
        MIXER_OBJECTF_HMIXER | MIXER_GETLINEINFOF_COMPONENTTYPE) == MMSYSERR_NOERROR);
    CHECK(line.cChannels == 2 && line.cControls == 2 && line.cConnections == 1);
    query.cbStruct = sizeof(query);
    query.dwLineID = line.dwLineID;
    query.cControls = 2;
    query.cbmxctrl = sizeof(controls[0]);
    query.pamxctrl = controls;
    CHECK(mixerGetLineControlsA((HMIXEROBJ)mixer, &query, MIXER_OBJECTF_HMIXER) == MMSYSERR_NOERROR);
    CHECK(controls[0].dwControlType == MIXERCONTROL_CONTROLTYPE_VOLUME);
    CHECK(controls[1].dwControlType == MIXERCONTROL_CONTROLTYPE_MUTE);
    CHECK(controls[0].Bounds.dwMaximum == 65535 && controls[0].fdwControl == MIXERCONTROL_CONTROLF_UNIFORM);
    details.cbStruct = sizeof(details);
    details.dwControlID = controls[0].dwControlID;
    details.cChannels = 1;
    details.cbDetails = sizeof(value);
    details.paDetails = &value;
    CHECK(mixerGetControlDetailsA((HMIXEROBJ)mixer, &details, MIXER_OBJECTF_HMIXER) == MMSYSERR_NOERROR);
    CHECK(value == 65535);
    value = 32768;
    CHECK(mixerSetControlDetails((HMIXEROBJ)mixer, &details, MIXER_OBJECTF_HMIXER) == MMSYSERR_NOERROR);
    value = 0;
    CHECK(mixerGetControlDetailsW((HMIXEROBJ)mixer, &details, MIXER_OBJECTF_HMIXER) == MMSYSERR_NOERROR);
    CHECK(value == 32768);
    CHECK(PlaySoundA("tone.wav", 0, SND_FILENAME | SND_NODEFAULT));
    details.dwControlID = controls[1].dwControlID;
    value = 1;
    CHECK(mixerSetControlDetails((HMIXEROBJ)mixer, &details, MIXER_OBJECTF_HMIXER) == MMSYSERR_NOERROR);
    CHECK(PlaySoundA("tone.wav", 0, SND_FILENAME | SND_NODEFAULT));
    wide_line.cbStruct = sizeof(wide_line);
    wide_line.dwComponentType = MIXERLINE_COMPONENTTYPE_SRC_WAVEOUT;
    CHECK(mixerGetLineInfoW((HMIXEROBJ)0, &wide_line, MIXER_GETLINEINFOF_COMPONENTTYPE) == MMSYSERR_NOERROR);
    CHECK(wide_line.fdwLine & MIXERLINE_LINEF_SOURCE);
    CHECK(wide_line.Target.dwType == MIXERLINE_TARGETTYPE_WAVEOUT);
    wide_query.cbStruct = sizeof(wide_query);
    wide_query.dwLineID = wide_line.dwLineID;
    wide_query.dwControlType = MIXERCONTROL_CONTROLTYPE_VOLUME;
    wide_query.cControls = 1;
    wide_query.cbmxctrl = sizeof(wide_control);
    wide_query.pamxctrl = &wide_control;
    CHECK(mixerGetLineControlsW(0, &wide_query, MIXER_GETLINECONTROLSF_ONEBYTYPE) == MMSYSERR_NOERROR);
    CHECK(wide_control.dwControlID != controls[0].dwControlID);
    CHECK(wide_control.szName[0] == 'V');
    CHECK(mixerClose(mixer) == MMSYSERR_NOERROR);
    CHECK(mixerClose(mixer) == MMSYSERR_INVALHANDLE);
    ExitProcess(0);
}
