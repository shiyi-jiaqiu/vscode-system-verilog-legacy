# Native server for extension 0.6.0

`slang-server-legacy.patch` applies to upstream
[60857ce8b4a01b6d11443fb1af1eb41c261c702c](https://github.com/hudson-trading/slang-server/tree/60857ce8b4a01b6d11443fb1af1eb41c261c702c).
The resulting version is `0.3.1+60857ce-legacy0.6.0`. Keep upstream MIT notices.
This patch is required alongside the 0.6.0 VSIX for versioned diagnostics.

The patch selects LSP's mandatory UTF-16 encoding at every position boundary,
retains document versions in diagnostics and inactive-region notifications,
and separates diagnostic refresh from metadata indexing. `diagnosticWarnings`
is an additive list of warning options without `-W`. The extension supplies a
complete set of positive/negative checkbox options. Changing the same set
refreshes cached diagnostics; removing groups or changing other compiler
settings rebuilds their mappings. Existing native flags remain in effect.

## Build

Check out the pinned upstream commit and initialize its direct submodules,
then apply this patch with `git apply`. Use CMake 3.28+ and a C++20 compiler.
For CentOS 7, the compiler must target glibc 2.17; a modern host compiler alone
does not establish that compatibility. The supplied Linux x86_64 build used
GCC 11.4 with a glibc 2.17 sysroot and these CMake options:

```sh
cmake -S slang-server -B slang-server-build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_COMPILER=/path/to/glibc217-toolchain/bin/x86_64-conda-linux-gnu-g++ \
  -DSLANG_SERVER_STATIC_LINK_STDLIB=ON \
  -DSLANG_SERVER_INCLUDE_TESTS=OFF \
  -DREFLECTCPP_USE_VCPKG=OFF
cmake --build slang-server-build --target slang_server -j 4
```

CMake's pinned dependency revisions are supplied by upstream. Existing source
caches can be reused with `FETCHCONTENT_SOURCE_DIR_FMT`,
`FETCHCONTENT_SOURCE_DIR_BOOST_REGEX` and `FETCHCONTENT_SOURCE_DIR_TOMLPLUSPLUS`.
The binary is `slang-server-build/bin/slang-server`.

Verify ELF symbol versions with `readelf --version-info`; this build requires
at most GLIBC_2.17 and links the C++ runtime statically. Actual LSP requests
were also checked under a CentOS 7 userspace with VS Code 1.84.2: Unicode
positions and rename ranges, current-version diagnostics, inactive branches,
warning toggles, filelist reloads, template routing, and native/fallback
transitions. That userspace check uses the host kernel, not a CentOS 7 VM.
