#include "basis/version.hpp"

#include <benchmark/benchmark.h>

#include <string_view>

namespace {

void version(benchmark::State& state) {
  for (auto _ : state) {
    std::string_view value = basis::version();
    benchmark::DoNotOptimize(value);
  }
}

BENCHMARK(version);

} // namespace
