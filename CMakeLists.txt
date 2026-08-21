cmake_minimum_required(VERSION 3.30)

project(basis VERSION 0.1.0 LANGUAGES CXX)

if(NOT CMAKE_CXX_COMPILER_ID MATCHES "^(AppleClang|Clang)$")
  message(FATAL_ERROR "basis requires Clang or Apple Clang")
endif()

set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(BASIS_BUILD_TESTS "Build the test suite" ON)
option(BASIS_BUILD_BENCHMARKS "Build benchmarks" ON)
option(BASIS_ENABLE_WERROR "Treat compiler warnings as errors" ON)
option(BASIS_ENABLE_CCACHE "Use ccache as the compiler launcher" ON)

if(BASIS_ENABLE_CCACHE)
  include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/ccache.cmake")
endif()

add_library(basis_warnings INTERFACE)
target_compile_options(
  basis_warnings
  INTERFACE
    -Wall
    -Wextra
    -Wpedantic
    -Wcast-align
    -Wcast-qual
    -Wconversion
    -Wdocumentation
    -Wdouble-promotion
    -Wextra-semi
    -Wformat=2
    -Wimplicit-fallthrough
    -Wmissing-declarations
    -Wnon-virtual-dtor
    -Wnull-dereference
    -Wold-style-cast
    -Woverloaded-virtual
    -Wshadow-all
    -Wsign-conversion
    -Wswitch-enum
    -Wthread-safety
    -Wundef
    -Wunreachable-code-aggressive
    -Wzero-as-null-pointer-constant
)

if(BASIS_ENABLE_WERROR)
  target_compile_options(basis_warnings INTERFACE -Werror)
endif()

add_library(basis_lib STATIC src/version.cpp)
add_library(basis::lib ALIAS basis_lib)
target_include_directories(
  basis_lib
  PUBLIC "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
)
target_compile_features(basis_lib PUBLIC cxx_std_23)
target_link_libraries(basis_lib PRIVATE basis_warnings)

add_executable(basis apps/basis/main.cpp)
target_link_libraries(basis PRIVATE basis::lib basis_warnings)

if(BASIS_BUILD_TESTS)
  enable_testing()
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)

  add_executable(basis_tests tests/version_test.cpp)
  target_link_libraries(
    basis_tests
    PRIVATE basis::lib basis_warnings GTest::gtest_main
  )
  gtest_discover_tests(basis_tests)
endif()

if(BASIS_BUILD_BENCHMARKS)
  find_package(benchmark CONFIG REQUIRED)

  add_executable(basis_benchmarks benchmarks/version_bench.cpp)
  target_link_libraries(
    basis_benchmarks
    PRIVATE basis::lib basis_warnings benchmark::benchmark_main
  )
endif()
