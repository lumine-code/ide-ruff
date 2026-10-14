def average(samples: list[float]) -> float:
    """Return the mean amplitude of a signal."""
    return sum(samples) / len(samples)


samples = [0.2, 0.8, -0.4, 0.5, 1.0]
print(average(measurements))
