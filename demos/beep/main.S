.text
.globl _start
_start:
    pushl $180
    pushl $440
    call _Beep@8
    testl %eax, %eax
    jz .Lerror
    pushl $0
    call _ExitProcess@4
.Lerror:
    pushl $1
    call _ExitProcess@4
