# Caemble worker applications

`ai`, `tts_voicevox`, `tts_kokoro`, `cae_simulation`, `cae_evaluation`, and `cae_prediction` are independent
launcher-discovered applications. The renamed folders retain executable IDs
`cae`, `evaluation`, `predictor`, and the additional `predictor-training` entrypoint.
Launcher manifests remain beside each application. From the repository root,
`bash ./li_launcher_install.sh` installs the Launcher and all worker dependencies
on Linux/WSL, with a separate Poetry environment for each project.

See [worker installation and operation](../../docs/operations/workers.md) for
configuration, startup, AI models, and transport ownership.
