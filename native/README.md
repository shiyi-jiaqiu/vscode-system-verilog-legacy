# Native server

`slang-server-legacy.patch` applies to upstream
[60857ce8b4a01b6d11443fb1af1eb41c261c702c](https://github.com/hudson-trading/slang-server/tree/60857ce8b4a01b6d11443fb1af1eb41c261c702c),
with its direct submodules initialized. The resulting server identifies itself as
`0.3.1+60857ce-legacy0.6.4`. Keep upstream MIT notices.

The 0.6.4 patch repairs named-declaration workspace search, virtual-interface
navigation in UVM projects, and member access after expressions such as function
calls and casts. Upgrade both the native service and extension to 0.6.4; updating the VSIX
alone does not install these native repairs. See the [real-project checks](tests/README.md#uvm-projects).

Extension 0.6.3 remains compatible with the rebuilt service. Its published kit
reuses the older 0.6.2 service, so that kit alone does not include these repairs.
The client waits for `slang/includeConfiguration` after initialization, then uses
those effective directories and include-search policies for include resolution.
Older binaries without that notification fall back after the startup timeout.
Version 0.6.2 removes embedded-script/template exclusions; rebuild both
components to replace the behavior shipped in 0.6.1.

The patch retains mandatory UTF-16 positions and versioned diagnostics from the
original 0.6.0 patch. It additionally repairs live reference candidates, disk include
invalidation, preprocessor-aware metadata, index replacement,
configuration-failure recovery, hover links, workspace-symbol ranges, diagnostic
codes and optional completion context. `diagnosticWarnings` remains an additive
list of options without `-W`; warning-only refresh reuses analysis. Changes to
preprocessor definitions or include configuration rebuild metadata as well. Ordinary metadata parsing avoids include expansion, with full preprocessing for files containing conditional directives, dynamic declarations or macro include paths. Compact header summaries retain precise include-candidate dependencies; worker SourceManagers release each primary buffer after extracting metadata. Initial indexing follows `initialized`, after the include-configuration notification, so it does not consume the client handshake timeout. See [follow-up verification](tests/review2.md).

## Apply and build

Initialize the pinned checkout's **direct** submodules before applying the patch.
The patch also modifies two files inside `external/slang`; apply it from the
server root with ordinary `git apply`, without `--index` or `--3way`.

```sh
git checkout 60857ce8b4a01b6d11443fb1af1eb41c261c702c
git submodule update --init
git apply --check /path/to/verilog-legacy/native/slang-server-legacy.patch
git apply /path/to/verilog-legacy/native/slang-server-legacy.patch
cmake -S . -B ../slang-server-build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DSLANG_SERVER_STATIC_LINK_STDLIB=ON \
  -DSLANG_SERVER_INCLUDE_TESTS=ON \
  -DREFLECTCPP_USE_VCPKG=OFF
cmake --build ../slang-server-build --target slang_server server_unittests -j 3
```

Use CMake 3.28+ and a C++20 compiler. The binary is
`slang-server-build/bin/slang-server`. CMake's pinned dependency revisions come
from upstream; existing caches can be supplied through the usual
`FETCHCONTENT_SOURCE_DIR_*` options. See [regression instructions](tests/README.md).

## Target ABI

The 0.6.4 Linux x86_64 binary is built with GCC 11.4 and a glibc 2.17
sysroot derived from CentOS 7.9 packages. Add these options to the build above:

```sh
-DCMAKE_CXX_COMPILER=/path/to/glibc217-toolchain/bin/x86_64-conda-linux-gnu-g++
-DPython_EXECUTABLE=/usr/bin/python3
```

The release binary requires at most `GLIBC_2.17`. Its dynamic dependencies are
libc, libm, libpthread and the ELF loader; the C++ runtime is linked statically.
Release verification runs the matching binary with CentOS 7.9 glibc libraries
under proot and the official VS Code 1.84.2 host. This exercises the userspace ABI
on the host kernel; it does not establish compatibility with a complete CentOS 7
kernel/VM or validate Windows/macOS and long-running sessions. Release notes record
the test results. The offline archive includes the patch and third-party notices.
