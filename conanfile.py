from typing import ClassVar

from conan import ConanFile


class BasisConan(ConanFile):
    name = "basis"
    version = "0.1.0"
    package_type = "application"
    required_conan_version = ">=2.0.0"

    settings = "os", "arch", "compiler", "build_type"
    generators = "CMakeDeps", "CMakeToolchain"

    requires: ClassVar[tuple[str, ...]] = ("gtest/1.17.0",)
