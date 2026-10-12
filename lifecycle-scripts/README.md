# Operator-supplied lifecycle scripts

Place your executable creation scripts in your chosen directory and set `scriptsDirectory` to its **absolute path** (for example `/home/wm/scripts`). If using this directory, configure its full filesystem path. No provisioning scripts are supplied.

Configure a relative creation-script path such as `hindsight/create.sh` in the `startScript` field of `config.json`. Existing containers are started and stopped by Podman directly, without invoking scripts. A destructive script may be recorded in `stopScript` for compatibility, but Stop/Restart never invoke it. See the root README for the full contract and security requirements.
