Authored MIT native PE32 fixture; rebuild with `npm run build:list-pointer`.

`npm run test:list-pointer` uploads this unchanged executable into Chromium. Four actual LISTBOX controls exercise ordinary single selection, extended ranges, multiple selection and variable-height owner drawing. The program subclasses each native control, forwards through the callable original procedure and checks real pointer messages, native selection/caret/anchor queries, capture and parent notifications. Browser acceptance drags over rows, shrinks ranges, toggles with Control, extends with Shift and checks selected owner-drawn pixels.

Stationary dragging outside the client must scroll using private `WM_SYSTIMER` messages while an application `WM_TIMER` with the same ID continues independently. F6 cancels through native `WM_CANCELMODE`; F7 transfers capture to the parent and releases it. An actual ComboLBox commits a dragged selection. Every stage must pass before normal window destruction exits zero. The fixture contains no third-party application binaries.

The combo stage also opens its native popup, starts a captured out-of-client drag with guest pointer messages and closes through `CB_SHOWDROPDOWN(FALSE)`. The hidden list must release capture immediately; unit coverage additionally checks private timer cleanup and notification order.
