#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#define TIMER_ID 1
#define TIMER_MS 40
#define CLIENT_WIDTH 480
#define CLIENT_HEIGHT 320
#define BALL_SIZE 8
#define PADDLE_WIDTH 72
#define PADDLE_HEIGHT 8
#define BRICK_ROWS 4
#define BRICK_COLUMNS 8
#define BRICK_WIDTH 54
#define BRICK_HEIGHT 14
#define BRICK_GAP_X 4
#define BRICK_GAP_Y 6
#define BRICK_START_X 10
#define BRICK_START_Y 34

static const char GAME_CLASS[] = "WineBrowserBreakoutWindow";
static const char STATUS_CLASS[] = "WineBrowserBreakoutStatus";
static const char GAME_CAPTION[] = "WineBrowser Breakout";
static const char STATUS_CAPTION[] = "Controls: arrows or mouse; Space pauses; R restarts";

static HINSTANCE instance;
static HWND gameWindow;
static HWND statusWindow;
static HBRUSH backgroundBrush;
static HBRUSH brickBrush;
static HBRUSH ballBrush;
static HBRUSH paddleBrush;
static HBRUSH statusPlayingBrush;
static HBRUSH statusPausedBrush;
static HBRUSH statusFinishedBrush;
static unsigned char bricks[BRICK_ROWS * BRICK_COLUMNS];
static int brickCount;
static int score;
static int ballX;
static int ballY;
static int ballVelocityX;
static int ballVelocityY;
static int paddleX;
static int moveLeft;
static int moveRight;
static int paused;
static int finished;
static int openWindows;

static LRESULT CALLBACK GameWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam);
static LRESULT CALLBACK StatusWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam);

static void CopyText(char *destination, const char *source) {
  while (*source) *destination++ = *source++;
  *destination = 0;
}

static void AppendText(char *destination, const char *source) {
  while (*destination) ++destination;
  CopyText(destination, source);
}

static void AppendNumber(char *destination, int value) {
  char digits[12];
  int count = 0;
  if (value < 0) {
    AppendText(destination, "-");
    value = -value;
  }
  do {
    digits[count++] = (char)('0' + value % 10);
    value /= 10;
  } while (value && count < (int)sizeof(digits));
  while (count) {
    char digit[2] = {digits[--count], 0};
    AppendText(destination, digit);
  }
}

static void UpdateCaptions(void) {
  char title[96];
  CopyText(title, GAME_CAPTION);
  AppendText(title, " - score ");
  AppendNumber(title, score);
  if (finished) AppendText(title, " - game over (R to restart)");
  else if (paused) AppendText(title, " - paused");
  if (gameWindow) SetWindowTextA(gameWindow, title);
  if (statusWindow) {
    if (finished) SetWindowTextA(statusWindow, "Game over - press R to restart");
    else if (paused) SetWindowTextA(statusWindow, "Paused - press Space to resume");
    else SetWindowTextA(statusWindow, STATUS_CAPTION);
    InvalidateRect(statusWindow, 0, TRUE);
  }
}

static void ResetGame(void) {
  int index;
  for (index = 0; index < BRICK_ROWS * BRICK_COLUMNS; ++index) bricks[index] = 1;
  brickCount = BRICK_ROWS * BRICK_COLUMNS;
  score = 0;
  ballX = CLIENT_WIDTH / 2 - BALL_SIZE / 2;
  ballY = CLIENT_HEIGHT - 72;
  ballVelocityX = 3;
  ballVelocityY = -4;
  paddleX = CLIENT_WIDTH / 2 - PADDLE_WIDTH / 2;
  moveLeft = 0;
  moveRight = 0;
  paused = 0;
  finished = 0;
  UpdateCaptions();
  if (gameWindow) InvalidateRect(gameWindow, 0, TRUE);
}

static void Fill(HDC dc, int left, int top, int right, int bottom, HBRUSH brush) {
  RECT rectangle;
  rectangle.left = left;
  rectangle.top = top;
  rectangle.right = right;
  rectangle.bottom = bottom;
  FillRect(dc, &rectangle, brush);
}

static void PaintGame(HWND window) {
  PAINTSTRUCT paint;
  RECT client;
  HDC dc = BeginPaint(window, &paint);
  int row;
  int column;
  GetClientRect(window, &client);
  FillRect(dc, &client, backgroundBrush);

  for (row = 0; row < BRICK_ROWS; ++row) {
    for (column = 0; column < BRICK_COLUMNS; ++column) {
      int index = row * BRICK_COLUMNS + column;
      if (bricks[index]) {
        int left = BRICK_START_X + column * (BRICK_WIDTH + BRICK_GAP_X);
        int top = BRICK_START_Y + row * (BRICK_HEIGHT + BRICK_GAP_Y);
        Fill(dc, left, top, left + BRICK_WIDTH, top + BRICK_HEIGHT, brickBrush);
      }
    }
  }

  Fill(dc, paddleX, CLIENT_HEIGHT - 24, paddleX + PADDLE_WIDTH,
       CLIENT_HEIGHT - 24 + PADDLE_HEIGHT, paddleBrush);
  Fill(dc, ballX, ballY, ballX + BALL_SIZE, ballY + BALL_SIZE, ballBrush);
  EndPaint(window, &paint);
}

static void PaintStatus(HWND window) {
  PAINTSTRUCT paint;
  RECT client;
  HBRUSH brush = finished ? statusFinishedBrush : (paused ? statusPausedBrush : statusPlayingBrush);
  HDC dc = BeginPaint(window, &paint);
  GetClientRect(window, &client);
  FillRect(dc, &client, brush);
  EndPaint(window, &paint);
}

static int Overlaps(int leftA, int topA, int rightA, int bottomA,
                    int leftB, int topB, int rightB, int bottomB) {
  return leftA < rightB && rightA > leftB && topA < bottomB && bottomA > topB;
}

static void MovePaddle(void) {
  if (moveLeft) paddleX -= 8;
  if (moveRight) paddleX += 8;
  if (paddleX < 4) paddleX = 4;
  if (paddleX + PADDLE_WIDTH > CLIENT_WIDTH - 4) paddleX = CLIENT_WIDTH - 4 - PADDLE_WIDTH;
}

static void Tick(void) {
  int oldY;
  int row;
  int column;
  int paddleY = CLIENT_HEIGHT - 24;
  if (paused || finished || !gameWindow) return;

  MovePaddle();
  oldY = ballY;
  ballX += ballVelocityX;
  ballY += ballVelocityY;

  if (ballX < 4) {
    ballX = 4;
    ballVelocityX = -ballVelocityX;
  } else if (ballX + BALL_SIZE > CLIENT_WIDTH - 4) {
    ballX = CLIENT_WIDTH - 4 - BALL_SIZE;
    ballVelocityX = -ballVelocityX;
  }
  if (ballY < 4) {
    ballY = 4;
    ballVelocityY = -ballVelocityY;
  }

  for (row = 0; row < BRICK_ROWS; ++row) {
    for (column = 0; column < BRICK_COLUMNS; ++column) {
      int index = row * BRICK_COLUMNS + column;
      int left = BRICK_START_X + column * (BRICK_WIDTH + BRICK_GAP_X);
      int top = BRICK_START_Y + row * (BRICK_HEIGHT + BRICK_GAP_Y);
      if (bricks[index] && Overlaps(ballX, ballY, ballX + BALL_SIZE, ballY + BALL_SIZE,
                                    left, top, left + BRICK_WIDTH, top + BRICK_HEIGHT)) {
        bricks[index] = 0;
        --brickCount;
        score += 10;
        ballVelocityY = -ballVelocityY;
        UpdateCaptions();
        row = BRICK_ROWS;
        break;
      }
    }
  }

  if (ballVelocityY > 0 && Overlaps(ballX, oldY, ballX + BALL_SIZE, ballY + BALL_SIZE,
                                    paddleX, paddleY, paddleX + PADDLE_WIDTH, paddleY + PADDLE_HEIGHT)) {
    int offset = ballX + BALL_SIZE / 2 - (paddleX + PADDLE_WIDTH / 2);
    ballVelocityX = offset / 8;
    if (ballVelocityX == 0) ballVelocityX = offset < 0 ? -1 : 1;
    if (ballVelocityX < -5) ballVelocityX = -5;
    if (ballVelocityX > 5) ballVelocityX = 5;
    ballVelocityY = -4;
    ballY = paddleY - BALL_SIZE;
  }

  if (ballY > CLIENT_HEIGHT) {
    finished = 1;
    UpdateCaptions();
  } else if (!brickCount) {
    finished = 1;
    UpdateCaptions();
  }
  if (gameWindow) InvalidateRect(gameWindow, 0, FALSE);
}

static void DestroyGameWindow(HWND window) {
  if (window) DestroyWindow(window);
}

static LRESULT CALLBACK GameWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_NCCREATE:
      return DefWindowProcA(window, message, wParam, lParam);
    case WM_CREATE:
      gameWindow = window;
      ++openWindows;
      if (!SetTimer(window, TIMER_ID, TIMER_MS, 0)) return -1;
      ResetGame();
      return 0;
    case WM_PAINT:
      PaintGame(window);
      return 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_TIMER:
      if (wParam == TIMER_ID) Tick();
      return 0;
    case WM_KEYDOWN:
      if (wParam == VK_LEFT) moveLeft = 1;
      else if (wParam == VK_RIGHT) moveRight = 1;
      else if (wParam == VK_SPACE && !(lParam & 0x40000000) && !finished) {
        paused = !paused;
        UpdateCaptions();
      } else if ((wParam == 'R' || wParam == 'r') && !(lParam & 0x40000000)) {
        ResetGame();
      }
      return 0;
    case WM_KEYUP:
      if (wParam == VK_LEFT) moveLeft = 0;
      else if (wParam == VK_RIGHT) moveRight = 0;
      return 0;
    case WM_MOUSEMOVE:
      paddleX = (int)(short)LOWORD(lParam) - PADDLE_WIDTH / 2;
      MovePaddle();
      InvalidateRect(window, 0, FALSE);
      return 0;
    case WM_DESTROY:
      if (window == gameWindow) {
        KillTimer(window, TIMER_ID);
        gameWindow = 0;
        finished = 1;
        UpdateCaptions();
      }
      --openWindows;
      if (openWindows <= 0) {
        DeleteObject(backgroundBrush);
        DeleteObject(brickBrush);
        DeleteObject(ballBrush);
        DeleteObject(paddleBrush);
        DeleteObject(statusPlayingBrush);
        DeleteObject(statusPausedBrush);
        DeleteObject(statusFinishedBrush);
        PostQuitMessage(0);
      }
      return 0;
    default:
      return DefWindowProcA(window, message, wParam, lParam);
  }
}

static LRESULT CALLBACK StatusWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_NCCREATE:
      return DefWindowProcA(window, message, wParam, lParam);
    case WM_CREATE:
      statusWindow = window;
      ++openWindows;
      return 0;
    case WM_PAINT:
      PaintStatus(window);
      return 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_DESTROY:
      if (window == statusWindow) statusWindow = 0;
      --openWindows;
      if (openWindows <= 0) {
        DeleteObject(backgroundBrush);
        DeleteObject(brickBrush);
        DeleteObject(ballBrush);
        DeleteObject(paddleBrush);
        DeleteObject(statusPlayingBrush);
        DeleteObject(statusPausedBrush);
        DeleteObject(statusFinishedBrush);
        PostQuitMessage(0);
      }
      return 0;
    default:
      return DefWindowProcA(window, message, wParam, lParam);
  }
}

void __attribute__((used)) entry(void) {
  WNDCLASSA gameClass;
  WNDCLASSA statusClass;
  RECT gameRect;
  RECT statusRect;
  MSG message;

  instance = GetModuleHandleA(0);
  backgroundBrush = CreateSolidBrush(RGB(16, 24, 32));
  brickBrush = CreateSolidBrush(RGB(220, 92, 69));
  ballBrush = CreateSolidBrush(RGB(244, 244, 244));
  paddleBrush = CreateSolidBrush(RGB(60, 190, 140));
  statusPlayingBrush = CreateSolidBrush(RGB(60, 128, 88));
  statusPausedBrush = CreateSolidBrush(RGB(194, 154, 40));
  statusFinishedBrush = CreateSolidBrush(RGB(172, 61, 61));
  if (!backgroundBrush || !brickBrush || !ballBrush || !paddleBrush ||
      !statusPlayingBrush || !statusPausedBrush || !statusFinishedBrush)
    ExitProcess(1);

  gameClass.style = CS_HREDRAW | CS_VREDRAW;
  gameClass.lpfnWndProc = GameWindowProc;
  gameClass.cbClsExtra = 0;
  gameClass.cbWndExtra = 0;
  gameClass.hInstance = instance;
  gameClass.hIcon = 0;
  gameClass.hCursor = 0;
  gameClass.hbrBackground = 0;
  gameClass.lpszMenuName = 0;
  gameClass.lpszClassName = GAME_CLASS;
  statusClass = gameClass;
  statusClass.lpfnWndProc = StatusWindowProc;
  statusClass.lpszClassName = STATUS_CLASS;

  if (!RegisterClassA(&gameClass) || !RegisterClassA(&statusClass)) ExitProcess(1);
  gameRect.left = 0;
  gameRect.top = 0;
  gameRect.right = CLIENT_WIDTH;
  gameRect.bottom = CLIENT_HEIGHT;
  statusRect.left = 0;
  statusRect.top = 0;
  statusRect.right = 230;
  statusRect.bottom = 120;
  if (!AdjustWindowRect(&gameRect, WS_OVERLAPPEDWINDOW, FALSE) ||
      !AdjustWindowRect(&statusRect, WS_OVERLAPPEDWINDOW, FALSE))
    ExitProcess(1);
  gameWindow = CreateWindowExA(0, GAME_CLASS, GAME_CAPTION,
                               WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                               24, 24, gameRect.right - gameRect.left,
                               gameRect.bottom - gameRect.top,
                               0, 0, instance, 0);
  if (!gameWindow) ExitProcess(1);
  statusWindow = CreateWindowExA(0, STATUS_CLASS, STATUS_CAPTION,
                                 WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                                 530, 40, statusRect.right - statusRect.left,
                                 statusRect.bottom - statusRect.top,
                                 0, 0, instance, 0);
  if (!statusWindow) {
    DestroyGameWindow(gameWindow);
    ExitProcess(1);
  }

  while (GetMessageA(&message, 0, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageA(&message);
  }
  ExitProcess((UINT)message.wParam);
}
