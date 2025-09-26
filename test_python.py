"""Test Python file for debugging AST parsing."""

def test_function():
    """A simple test function."""
    return "Hello, World!"

class TestClass:
    """A simple test class."""

    def __init__(self):
        self.value = 42

    def get_value(self):
        """Get the value."""
        return self.value

if __name__ == "__main__":
    print(test_function())
    obj = TestClass()
    print(obj.get_value())
