# Installing opengrep and trivy

`scan-code` only **runs** these tools. It never installs them. When `check-tools.js` reports that one of them is missing, share the matching block below with the user and stop. After they install the tool and confirm, re-run the prerequisites step.

The commands below mirror each tool's official install guidance. When in doubt, link the user to the source pages:

- opengrep — <https://github.com/opengrep/opengrep#installation>
- trivy — <https://trivy.dev/docs/latest/getting-started/installation/>

## opengrep

| Platform | Install command |
|----------|-----------------|
| Linux / macOS | `curl -fsSL https://raw.githubusercontent.com/opengrep/opengrep/main/install.sh \| bash` |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/opengrep/opengrep/main/install.ps1 \| iex` |
| Manual | Download the binary for your OS / architecture from <https://github.com/opengrep/opengrep/releases>, place it on `PATH`, mark it executable. |

To pin a specific version on Windows, the official guidance is:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/opengrep/opengrep/main/install.ps1))) -Version v1.16.0
```

Verify with `opengrep --version` once installation completes.

## trivy

Trivy publishes more install routes than opengrep. Pick the one that matches the user's environment; do not chain them.

| Platform / package manager | Install command |
|----------------------------|-----------------|
| macOS / Linux (Homebrew)   | `brew install trivy` |
| Debian / Ubuntu (apt repo) | First add the repo: `sudo apt-get install -y wget gnupg`, then `wget -qO - https://aquasecurity.github.io/trivy-repo/deb/public.key \| gpg --dearmor \| sudo tee /usr/share/keyrings/trivy.gpg > /dev/null`, then `echo "deb [signed-by=/usr/share/keyrings/trivy.gpg] https://aquasecurity.github.io/trivy-repo/deb generic main" \| sudo tee -a /etc/apt/sources.list.d/trivy.list`, then `sudo apt-get update && sudo apt-get install -y trivy`. |
| Debian / Ubuntu (single .deb) | `wget https://github.com/aquasecurity/trivy/releases/latest/download/trivy_<version>_Linux-64bit.deb && sudo dpkg -i trivy_<version>_Linux-64bit.deb` (replace `<version>` with the version from the releases page). |
| RHEL / CentOS (yum repo)   | Add the repo file at `/etc/yum.repos.d/trivy.repo` (see the official page for the exact contents), then `sudo yum -y install trivy`. |
| Arch Linux                 | `sudo pacman -S trivy` |
| FreeBSD                    | `pkg install trivy` |
| Windows                    | Download `trivy_<version>_windows-64bit.zip` from <https://github.com/aquasecurity/trivy/releases>, unzip, and place `trivy.exe` somewhere on `PATH`. |
| Container image            | `docker pull aquasec/trivy` (or `ghcr.io/aquasecurity/trivy`). The skill assumes a local binary, so prefer this only for users who already run trivy via Docker. |
| Install script             | `curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \| sudo sh -s -- -b /usr/local/bin` |

Verify with `trivy --version` once installation completes. The first run downloads the vulnerability database, which can take a couple of minutes.

## What to say to the user

Use plain language, for example:

> "I need a small open-source tool called **opengrep** to check your code, and another one called **trivy** to check your packages. Neither is on this machine yet. Please install them with the commands below, then tell me when you are ready."

Paste **only** the row that matches their platform. Do not present the full table — keep it focused on the one method they should use.
