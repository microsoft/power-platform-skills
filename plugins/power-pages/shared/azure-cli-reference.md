# Azure CLI Reference

Azure CLI is required for authentication and API calls in Power Pages workflows.

**Official Documentation**: [Install Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli?view=azure-cli-latest)

## Check Installation

```powershell
az --version
```

If this command fails or returns "command not found", install Azure CLI using one of the methods below.

## Installation Methods

### Method 1: MSI Installer (Recommended)

Download and run the MSI installer:

1. Download from: https://aka.ms/installazurecliwindowsx64
2. Run the installer and follow the prompts
3. Restart your terminal after installation

### Method 2: Winget

```powershell
winget install -e --id Microsoft.AzureCLI
```

Restart terminal after installation.

### Method 3: PowerShell Script

```powershell
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri https://aka.ms/installazurecliwindowsx64 -OutFile .\AzureCLI.msi
Start-Process msiexec.exe -Wait -ArgumentList '/I AzureCLI.msi /quiet'
Remove-Item .\AzureCLI.msi
```

Restart terminal after installation.

## Verify Installation

After installation and restarting your terminal:

```powershell
az --version
```

## Authentication

```powershell
# Check current login status
az account show

# If not logged in, authenticate
az login
```

## Troubleshooting

### "az is not recognized" after installation

1. Close and reopen your terminal
2. If still not working, verify the installation path is in your PATH environment variable:
   - Default path: `C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin`

### Installation fails with winget

If winget installation fails, use the MSI installer method instead (see above).

### Permission errors during installation

Run PowerShell as Administrator and try the installation again.

### Multiple Azure accounts

```powershell
# List all accounts
az account list --output table

# Set specific subscription
az account set --subscription "<subscription-id-or-name>"
```
