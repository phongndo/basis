#include "basis/version.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <string_view>

TEST(VersionTest, ReturnsSemverShapedString) {
  const std::string_view value = basis::version();
  EXPECT_FALSE(value.empty());
  EXPECT_EQ(std::ranges::count(value, '.'), 2);
}

TEST(VersionTest, IsStableAcrossCalls) { EXPECT_EQ(basis::version(), basis::version()); }
