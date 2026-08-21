find_program(CCACHE_PROGRAM ccache)

if(CCACHE_PROGRAM)
  set(CMAKE_CXX_COMPILER_LAUNCHER "${CCACHE_PROGRAM}" CACHE FILEPATH "ccache C++ compiler launcher")
  set(CMAKE_C_COMPILER_LAUNCHER "${CCACHE_PROGRAM}" CACHE FILEPATH "ccache C compiler launcher")
  message(STATUS "ccache: enabled (${CCACHE_PROGRAM})")
else()
  message(STATUS "ccache: not found — compiler launcher disabled")
endif()
