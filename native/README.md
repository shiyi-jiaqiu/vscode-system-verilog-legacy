# Native server for the 0.6.0 review fixes

`slang-server-legacy.patch` applies to upstream
[60857ce8b4a01b6d11443fb1af1eb41c261c702c](https://github.com/hudson-trading/slang-server/tree/60857ce8b4a01b6d11443fb1af1eb41c261c702c),
with its direct submodules initialized. The resulting server identifies itself as
`0.3.1+60857ce-legacy0.6.0-review1`. Keep upstream MIT notices.

This revision changes both the client and native service. Rebuild and upgrade both.
The client waits for `slang/includeConfiguration` after initialization, then uses
those effective directories and include-search policies to route literal template
dependencies. Older binaries without that notification fall back after the startup
timeout. No Perl code is executed.

The patch retains mandatory UTF-16 positions and versioned diagnostics from the
original 0.6.0 patch. It additionally repairs live reference candidates, disk include
invalidation, template exclusion, preprocessor-aware metadata, index replacement,
configuration-failure recovery, hover links, workspace-symbol ranges, diagnostic
codes and optional completion context. `diagnosticWarnings` remains an additive
list of options without `-W`; warning-only refresh reuses analysis. Changes to
preprocessor definitions or include configuration rebuild metadata as well.

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

The modern Linux build used to validate these fixes is a development artifact,
not a CentOS 7 release binary. Static C++ runtimes alone do not establish glibc
2.17 compatibility. The previous offline kit predates these fixes and cannot be
used to validate this source revision.

A CentOS 7 release still needs a glibc 2.17 toolchain/sysroot build, SHA256 and build
records, ELF symbol/dependency checks on that exact binary, and its protocol and
VS Code 1.84.2 tests in the target environment. Keep container/userspace results
separate from a complete CentOS 7 VM. Include the actual offline package's third
party license notices. No new target-ABI acceptance is claimed by this patch.
