/* Original WineBrowser contributors, MIT. Shared native SDK GUI drawing inputs. */
#ifndef FRAME_CONTROLS_LAYOUT_H
#define FRAME_CONTROLS_LAYOUT_H
#define UNICODE
#include <windows.h>
static const UINT frame_flags[] = {0,DFCS_PUSHED,DFCS_CHECKED,DFCS_INACTIVE,DFCS_FLAT,
    DFCS_MONO,DFCS_TRANSPARENT,0,DFCS_ADJUSTRECT,0};
static BOOL paint_controls(HDC dc, unsigned stage) {
    RECT area={0,96,640,340};
    HBRUSH back=CreateSolidBrush(RGB(60,80,100));
    if(!back || !FillRect(dc,&area,back) || !DeleteObject(back)) return FALSE;
    SetTextColor(dc,RGB(18,52,86));SetBkColor(dc,RGB(140,170,200));SetBkMode(dc,TRANSPARENT);
    SetBrushOrgEx(dc,5,-3,NULL);SetPolyFillMode(dc,WINDING);
    if(stage==7){HRGN a=CreateRectRgn(0,96,570,324),b=CreateRectRgn(227,110,346,282);
        if(!a||!b||!CombineRgn(a,a,b,RGN_DIFF)||!SelectClipRgn(dc,a)||!DeleteObject(a)||!DeleteObject(b))return FALSE;}
    const UINT types[]={DFC_BUTTON,DFC_BUTTON,DFC_BUTTON,DFC_SCROLL,DFC_SCROLL,DFC_SCROLL,DFC_SCROLL,DFC_MENU,DFC_MENU};
    const UINT states[]={DFCS_BUTTONPUSH,DFCS_BUTTONCHECK,DFCS_BUTTON3STATE,DFCS_SCROLLUP,DFCS_SCROLLDOWN,DFCS_SCROLLLEFT,DFCS_SCROLLRIGHT,DFCS_MENUARROW,DFCS_MENUCHECK};
    HBRUSH marker=CreateSolidBrush(RGB(20,100,220));if(!marker)return FALSE;
    for(int column=0;column<9;column++)for(int row=0;row<3;row++){
        int x=8+column*70;
        RECT rect=row==0?(RECT){x+15,112,x+47,144}:row==1?(RECT){x+9,180,x+55,216}:(RECT){x+3,256,x+61,272};
        RECT expected=rect;if(stage==8&&(types[column]==DFC_SCROLL||states[column]==DFCS_BUTTONPUSH)){expected.left+=2;expected.top+=2;expected.right-=2;expected.bottom-=2;}
        SetLastError(777);
        if(!DrawFrameControl(dc,&rect,types[column],states[column]|frame_flags[stage])||GetLastError()!=777)return FALSE;
        if(rect.left!=expected.left||rect.top!=expected.top||rect.right!=expected.right||rect.bottom!=expected.bottom)return FALSE;
        if(stage==8&&!FrameRect(dc,&rect,marker))return FALSE;
    }
    return DeleteObject(marker)&&SelectClipRgn(dc,NULL)!=ERROR;
}
#endif
