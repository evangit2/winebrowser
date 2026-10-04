Original MIT-licensed i386 Windows fixture for native Wine exception delivery.

Build with `sh scripts/build-native-exceptions-fixture.sh`. The binary is timestamp-free and stripped. `node --test tests/wine-exceptions.test.js` loads the packaged original Wine DLLs, installs two real FS exception-registration frames, checks a caller-defined exception and its parameters, and continues twice through native `NtContinue`. The separate browser 7-Zip GUI gate covers upstream MSVC typed C++ catching and unwinding on Cancel.
