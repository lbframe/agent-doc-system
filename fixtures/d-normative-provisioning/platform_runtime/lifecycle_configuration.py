from dataclasses import dataclass


@dataclass(frozen=True)
class LifecycleConfiguration:
    python_environment_id: str
    python_executor: str
    python_runtime_root: str
