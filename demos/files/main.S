.text
.globl _start
_start:
    pushl $0
    pushl $0
    pushl $3
    pushl $0
    pushl $1
    pushl $0x80000000
    pushl $input_path
    call _CreateFileA@28
    cmpl $-1, %eax
    je .Lerror
    movl %eax, input_handle

    pushl $0
    pushl $bytes_read
    pushl $256
    pushl $read_buffer
    pushl input_handle
    call _ReadFile@20
    testl %eax, %eax
    jz .Lclose_input_error

    pushl input_handle
    call _CloseHandle@4
    testl %eax, %eax
    jz .Lerror

    pushl $0
    pushl $0
    pushl $2
    pushl $0
    pushl $0
    pushl $0x40000000
    pushl $output_path
    call _CreateFileA@28
    cmpl $-1, %eax
    je .Lerror
    movl %eax, output_handle

    pushl $0
    pushl $bytes_written
    pushl $output_message_end-output_message
    pushl $output_message
    pushl output_handle
    call _WriteFile@20
    testl %eax, %eax
    jz .Lclose_output_error

    pushl output_handle
    call _CloseHandle@4
    testl %eax, %eax
    jz .Lerror

    pushl $-11
    call _GetStdHandle@4
    testl %eax, %eax
    jz .Lerror
    cmpl $-1, %eax
    je .Lerror
    movl %eax, stdout_handle
    pushl $0
    pushl $written
    pushl bytes_read
    pushl $read_buffer
    pushl stdout_handle
    call _WriteFile@20
    testl %eax, %eax
    jz .Lerror
    pushl $0
    call _ExitProcess@4

.Lclose_output_error:
    pushl output_handle
    call _CloseHandle@4
    jmp .Lerror
.Lclose_input_error:
    pushl input_handle
    call _CloseHandle@4
.Lerror:
    pushl $1
    call _ExitProcess@4

.section .rdata,"dr"
input_path:
    .asciz "assets/message.txt"
output_path:
    .asciz "output.txt"
output_message:
    .ascii "files demo: generated output file.\r\n"
output_message_end:

.bss
.align 4
read_buffer:
    .space 256

.data
input_handle:
    .long 0
output_handle:
    .long 0
stdout_handle:
    .long 0
bytes_read:
    .long 0
bytes_written:
    .long 0
written:
    .long 0
