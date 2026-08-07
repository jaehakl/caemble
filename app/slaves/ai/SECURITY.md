# AI runtime dependency review

`pip-audit` covers packages available from PyPI. This worker also installs GPU wheels from explicit vendor indexes, so every dependency update and the weekly security workflow must review the generated CycloneDX SBOM against the PyTorch, NVIDIA CUDA, and llama-cpp-python vendor advisories.

The current separately reviewed components are:

- `torch==2.7.0+cu128` from the PyTorch CUDA 12.8 index
- `llama-cpp-python` from the configured CUDA wheel index
- `nvidia-cublas==13.1.1.3`
- `nvidia-cuda-runtime==13.1.80`

`CVE-2025-69872` for `diskcache==5.6.3` currently has no fixed release and is explicitly ignored by CI. Remove the ignore as soon as a fixed release is available. Do not load cache files from an untrusted or shared-writable directory.
