// MinGW's WRL omits this RAII class used by an unused inline SDK helper.
#include <windows.h>
#define _uuidof __uuidof
namespace Microsoft { namespace WRL { namespace Wrappers {
class FileHandle {
 HANDLE value;
public:
 explicit FileHandle(HANDLE h) : value(h) {}
 ~FileHandle() { if (value != INVALID_HANDLE_VALUE && value) CloseHandle(value); }
 HANDLE Get() const { return value; }
 FileHandle(const FileHandle&) = delete;
 FileHandle& operator=(const FileHandle&) = delete;
};
}}}
