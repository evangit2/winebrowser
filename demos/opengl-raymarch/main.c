/* Freestanding native Windows PE32. OpenGL 3.3 core and GLSL 330. */
#include <windows.h>
#include <GL/gl.h>
#include <stddef.h>
#include "shaders.h"
#define WIDTH 800
#define HEIGHT 600
#define GL_VERTEX_SHADER 0x8b31
#define GL_FRAGMENT_SHADER 0x8b30
#define GL_COMPILE_STATUS 0x8b81
#define GL_LINK_STATUS 0x8b82
#define GL_ARRAY_BUFFER 0x8892
#define GL_STATIC_DRAW 0x88e4
#define FN(ret, name, args) static ret (APIENTRY *name) args
FN(HGLRC, createContext, (HDC, HGLRC, const int *));
FN(GLuint, createShader, (GLenum));
FN(GLuint, createProgram, (void));
FN(void, shaderSource, (GLuint, GLsizei, const char **, const GLint *));
FN(void, compileShader, (GLuint));
FN(void, getShaderiv, (GLuint, GLenum, GLint *));
FN(void, getShaderInfoLog, (GLuint, GLsizei, GLsizei *, char *));
FN(void, attachShader, (GLuint, GLuint));
FN(void, linkProgram, (GLuint));
FN(void, getProgramiv, (GLuint, GLenum, GLint *));
FN(void, useProgram, (GLuint));
FN(GLint, getUniformLocation, (GLuint, const char *));
FN(void, uniform1f, (GLint, GLfloat));
FN(void, uniform2f, (GLint, GLfloat, GLfloat));
FN(void, genVertexArrays, (GLsizei, GLuint *));
FN(void, bindVertexArray, (GLuint));
FN(void, genBuffers, (GLsizei, GLuint *));
FN(void, bindBuffer, (GLenum, GLuint));
FN(void, bufferData, (GLenum, ptrdiff_t, const void *, GLenum));
FN(void, enableVertexAttribArray, (GLuint));
FN(void, vertexAttribPointer, (GLuint, GLint, GLenum, GLboolean, GLsizei, const void *));
FN(void, deleteBuffers, (GLsizei, const GLuint *));
FN(void, deleteVertexArrays, (GLsizei, const GLuint *));
FN(void, deleteShader, (GLuint));
FN(void, deleteProgram, (GLuint));
void *memset(void *p, int value, size_t count) {
    volatile unsigned char *b = p;
    while (count--) *b++ = (unsigned char)value;
    return p;
}
static int running = 1, paused = 0;
static float cameraAngle = 0.28f;
static LRESULT CALLBACK windowProc(HWND hwnd, UINT msg, WPARAM w, LPARAM l) {
    if (msg == WM_CLOSE) { running = 0; return 0; }
    if (msg == WM_KEYDOWN) {
        if (w == VK_ESCAPE) running = 0;
        if (w == VK_SPACE) paused = !paused;
        if (w == VK_LEFT) cameraAngle -= 0.16f;
        if (w == VK_RIGHT) cameraAngle += 0.16f;
        return 0;
    }
    return DefWindowProcA(hwnd, msg, w, l);
}
static GLuint shader(GLenum kind, const char *source) {
    GLuint id = createShader(kind);
    GLint compiled = 0;
    shaderSource(id, 1, &source, 0);
    compileShader(id);
    getShaderiv(id, GL_COMPILE_STATUS, &compiled);
    if (!compiled) {
        char text[2048] = {0};
        getShaderInfoLog(id, sizeof(text), 0, text);
        MessageBoxA(0, text, "GLSL compilation failed", MB_OK);
        ExitProcess(3);
    }
    return id;
}
#define LOAD(name, symbol) do { *(PROC *)&name = wglGetProcAddress(symbol); if (!name) ExitProcess(2); } while (0)
void mainCRTStartup(void) {
    HINSTANCE instance = GetModuleHandleA(0);
    WNDCLASSA wc = {0};
    wc.style = CS_OWNDC; wc.lpfnWndProc = windowProc;
    wc.hInstance = instance; wc.lpszClassName = "OpenGLRaymarch";
    if (!RegisterClassA(&wc)) ExitProcess(1);
    RECT rect = {0, 0, WIDTH, HEIGHT};
    AdjustWindowRect(&rect, WS_OVERLAPPEDWINDOW, FALSE);
    HWND hwnd = CreateWindowExA(0, wc.lpszClassName,
        "OpenGL 3.3 - raymarched scene | arrows: camera | Space: pause | Esc: exit",
        WS_OVERLAPPEDWINDOW | WS_VISIBLE, 0, 0, rect.right - rect.left, rect.bottom - rect.top,
        0, 0, instance, 0);
    if (!hwnd) ExitProcess(1);
    HDC dc = GetDC(hwnd);
    PIXELFORMATDESCRIPTOR pfd = {0};
    pfd.nSize = sizeof(pfd); pfd.nVersion = 1;
    pfd.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
    pfd.iPixelType = PFD_TYPE_RGBA; pfd.cColorBits = 32; pfd.cDepthBits = 24; pfd.cStencilBits = 8;
    if (!SetPixelFormat(dc, ChoosePixelFormat(dc, &pfd), &pfd)) ExitProcess(1);
    HGLRC temporary = wglCreateContext(dc);
    if (!temporary || !wglMakeCurrent(dc, temporary)) ExitProcess(1);
    LOAD(createContext, "wglCreateContextAttribsARB");
    const int attributes[] = {0x2091, 3, 0x2092, 3, 0x9126, 1, 0};
    HGLRC context = createContext(dc, 0, attributes);
    wglMakeCurrent(0, 0); wglDeleteContext(temporary);
    if (!context || !wglMakeCurrent(dc, context)) ExitProcess(1);
    LOAD(createShader, "glCreateShader"); LOAD(createProgram, "glCreateProgram");
    LOAD(shaderSource, "glShaderSource"); LOAD(compileShader, "glCompileShader");
    LOAD(getShaderiv, "glGetShaderiv"); LOAD(getShaderInfoLog, "glGetShaderInfoLog");
    LOAD(attachShader, "glAttachShader"); LOAD(linkProgram, "glLinkProgram");
    LOAD(getProgramiv, "glGetProgramiv"); LOAD(useProgram, "glUseProgram");
    LOAD(getUniformLocation, "glGetUniformLocation"); LOAD(uniform1f, "glUniform1f");
    LOAD(uniform2f, "glUniform2f"); LOAD(genVertexArrays, "glGenVertexArrays");
    LOAD(bindVertexArray, "glBindVertexArray"); LOAD(genBuffers, "glGenBuffers");
    LOAD(bindBuffer, "glBindBuffer"); LOAD(bufferData, "glBufferData");
    LOAD(enableVertexAttribArray, "glEnableVertexAttribArray");
    LOAD(vertexAttribPointer, "glVertexAttribPointer"); LOAD(deleteBuffers, "glDeleteBuffers");
    LOAD(deleteVertexArrays, "glDeleteVertexArrays"); LOAD(deleteShader, "glDeleteShader");
    LOAD(deleteProgram, "glDeleteProgram");
    GLuint vs = shader(GL_VERTEX_SHADER, scene_vert), fs = shader(GL_FRAGMENT_SHADER, scene_frag);
    GLuint program = createProgram(); attachShader(program, vs); attachShader(program, fs);
    linkProgram(program);
    GLint linked = 0; getProgramiv(program, GL_LINK_STATUS, &linked);
    if (!linked) ExitProcess(4);
    useProgram(program);
    const GLint timeUniform = getUniformLocation(program, "time");
    const GLint cameraUniform = getUniformLocation(program, "camera");
    const GLint resolutionUniform = getUniformLocation(program, "resolution");
    GLuint vao, vbo;
    genVertexArrays(1, &vao); bindVertexArray(vao);
    genBuffers(1, &vbo); bindBuffer(GL_ARRAY_BUFFER, vbo);
    const float triangle[] = {-1, -1, 3, -1, -1, 3};
    bufferData(GL_ARRAY_BUFFER, sizeof(triangle), triangle, GL_STATIC_DRAW);
    vertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 2 * sizeof(float), 0);
    enableVertexAttribArray(0);
    glViewport(0, 0, WIDTH, HEIGHT); uniform2f(resolutionUniform, WIDTH, HEIGHT);
    DWORD previous = GetTickCount();
    float elapsed = 0.0f;
    MSG msg;
    while (running) {
        while (PeekMessageA(&msg, 0, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg); DispatchMessageA(&msg);
        }
        DWORD now = GetTickCount();
        if (!paused) elapsed += (float)(now - previous) * 0.001f;
        previous = now;
        uniform1f(timeUniform, elapsed); uniform1f(cameraUniform, cameraAngle);
        glDrawArrays(GL_TRIANGLES, 0, 3);
        if (glGetError() != GL_NO_ERROR || !SwapBuffers(dc)) ExitProcess(5);
    }
    deleteBuffers(1, &vbo); deleteVertexArrays(1, &vao);
    useProgram(0); deleteProgram(program); deleteShader(vs); deleteShader(fs);
    wglMakeCurrent(0, 0); wglDeleteContext(context);
    ReleaseDC(hwnd, dc); DestroyWindow(hwnd); ExitProcess(0);
}
