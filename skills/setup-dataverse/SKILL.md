---
description: Setup Dataverse tables and schema for your Power Pages site. Analyzes your site to recommend tables, creates tables using OData Web API, and adds sample data.
user-invocable: true
allowed-tools: Bash(pac:*), Bash(az:*)
model: sonnet
---

# Setup Dataverse Tables

This skill guides makers through setting up Dataverse tables and schema for their Power Pages site. It analyzes the site created in the previous step, recommends appropriate tables, and helps create them with sample data.

## Memory Bank

This skill uses a **memory bank** (`memory-bank.md`) to persist context across sessions.

**Follow the instructions in `${CLAUDE_PLUGIN_ROOT}/shared/memory-bank.md`** for:
- Checking and reading the memory bank before starting
- Skipping completed steps and resuming progress
- Updating the memory bank after each major step

## Workflow Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: Resume or Start Fresh                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Check if continuing from /create-site                                    │
│  • Identify existing site project path                                      │
│  • Offer to proceed or show resume command                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: Analyze Site & Recommend Schema                                    │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Read site source code and configuration                                  │
│  • Identify data requirements from components                               │
│  • Recommend tables and columns based on site features                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: Set Up OData Web API Authentication                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Configure Azure CLI authentication                                       │
│  • Get environment URL and access token                                     │
│  • Set up API headers for Dataverse calls                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: Create Tables in Dataverse                                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Create custom tables with recommended schema                             │
│  • Set up primary columns and data types                                    │
│  • Configure table relationships if needed                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 5: Add Sample Data                                                    │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Generate realistic dummy data                                            │
│  • Insert sample records into tables                                        │
│  • Verify data is accessible                                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
                        Next: /setup-webapi skill
```

---

## STEP 1: Resume or Start Fresh

### Check Memory Bank First

**Before asking questions**, check if a memory bank exists:

1. If continuing from `/create-site` in the same session, use the known project path
2. Otherwise, ask the user for the project path
3. Read `<PROJECT_PATH>/memory-bank.md` if it exists
4. Extract:
   - Project name and framework
   - Site features (to recommend appropriate tables)
   - Any previously chosen preferences
   - Whether this skill was already partially completed

If the memory bank shows `/setup-dataverse` steps already completed:

- Inform the user what was done
- Ask if they want to add more tables, modify existing ones, or skip to next steps

### Check Context

First, determine if the user is continuing from `/create-site` or starting fresh.

**If continuing from create-site:**

Show this message:

> **Ready for Next Step!**
>
> Your Power Pages site has been created. Now let's set up the Dataverse tables to store and manage your site's data.
>
> Would you like to proceed with setting up Dataverse tables for your site?

Use the `AskUserQuestion` tool with these options:

| Option | Description |
|--------|-------------|
| **Yes, proceed** | Continue to analyze the site and set up tables |
| **Show me the command** | Display the command to run this skill later: `/setup-dataverse` |
| **Not now** | Exit and save progress for later |

**If starting fresh (no prior context):**

Ask the user:

> To set up Dataverse tables, I need to know about your Power Pages site.
>
> Do you have an existing site project, or would you like to create one first?

| Option | Description |
|--------|-------------|
| **I have an existing site** | Provide the path to your site project |
| **Create a site first** | Run `/create-site` to create a new Power Pages site |

If they have an existing site, ask for the project path using `AskUserQuestion`.

### Resume Command

If the user selects "Show me the command", display:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  Resume Command                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Run this command when you're ready to continue:                            │
│                                                                             │
│    /setup-dataverse                                                         │
│                                                                             │
│  Or type: "Set up Dataverse tables for my Power Pages site"                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## STEP 2: Analyze Site & Recommend Schema

### Read Site Configuration

Read the site's source code to understand data requirements:

1. **Read powerpages.config.json** to get site name and structure
2. **Scan component files** for data patterns:
   - Forms (contact forms, registration forms, feedback forms)
   - Lists/Tables (product listings, team members, services)
   - Cards (testimonials, portfolio items, blog posts)
   - User data (profiles, preferences, submissions)

### Identify Data Requirements

Look for these patterns in the code:

| Pattern | Recommended Table |
|---------|-------------------|
| Contact form with name, email, message | `cr_contactsubmission` |
| Product/service cards | `cr_product` or `cr_service` |
| Team member section | `cr_teammember` |
| Testimonials/Reviews | `cr_testimonial` |
| Blog/News section | `cr_blogpost` |
| FAQ section | `cr_faq` |
| Event listings | `cr_event` |
| Portfolio/Gallery items | `cr_portfolioitem` |
| User feedback/Surveys | `cr_feedback` |

### Present Recommendations

After analysis, present the recommended schema using `AskUserQuestion`:

> **Recommended Tables for Your Site**
>
> Based on your site's features, I recommend creating these Dataverse tables:
>
> [List tables with columns based on analysis]
>
> Would you like to proceed with this schema?

| Option | Description |
|--------|-------------|
| **Yes, create these tables** | Proceed with recommended schema |
| **Modify the schema** | Let me adjust columns or add/remove tables |
| **Add more tables** | I need additional tables for other data |

---

## STEP 3: Set Up OData Web API Authentication

This skill uses the Dataverse OData Web API for all table and data operations. Operations will use:

1. **Dataverse Web API** for table creation, schema management, and data operations
2. **Azure CLI** for authentication (`az account get-access-token`)
3. **PowerShell** for scripting API calls
4. **Client-side `/_api/` calls** from the Power Pages site for runtime data access

Ensure Azure CLI is authenticated before proceeding:

```powershell
# Verify Azure CLI is logged in
az account show

# If not logged in, run:
az login
```

---

## STEP 4: Create Tables in Dataverse

Create tables using the Dataverse Web API. First, set up the API connection:

```powershell
# Get the environment URL
pac org who

# Get access token using Azure CLI
$envUrl = "https://<org>.crm.dynamics.com"  # Replace with your org URL
$token = (az account get-access-token --resource $envUrl --query accessToken -o tsv)

# Set up headers for API calls
$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
    "OData-MaxVersion" = "4.0"
    "OData-Version" = "4.0"
    "MSCRM.SolutionUniqueName" = "YourSolutionName"  # Optional: add to a solution
}

$baseUrl = "$envUrl/api/data/v9.2"
```

#### Example: Create Contact Submission Table

```powershell
# Create the table (entity)
$tableDefinition = @{
    "@odata.type" = "Microsoft.Dynamics.CRM.EntityMetadata"
    "SchemaName" = "cr_contactsubmission"
    "DisplayName" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{
                "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"
                "Label" = "Contact Submission"
                "LanguageCode" = 1033
            }
        )
    }
    "DisplayCollectionName" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{
                "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"
                "Label" = "Contact Submissions"
                "LanguageCode" = 1033
            }
        )
    }
    "Description" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{
                "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"
                "Label" = "Stores contact form submissions from the website"
                "LanguageCode" = 1033
            }
        )
    }
    "OwnershipType" = "UserOwned"
    "HasNotes" = $false
    "HasActivities" = $false
    "PrimaryNameAttribute" = "cr_name"
    "Attributes" = @(
        @{
            "@odata.type" = "Microsoft.Dynamics.CRM.StringAttributeMetadata"
            "SchemaName" = "cr_name"
            "AttributeType" = "String"
            "FormatName" = @{ "Value" = "Text" }
            "MaxLength" = 100
            "DisplayName" = @{
                "@odata.type" = "Microsoft.Dynamics.CRM.Label"
                "LocalizedLabels" = @(
                    @{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Name"; "LanguageCode" = 1033 }
                )
            }
            "IsPrimaryName" = $true
        }
    )
}

$body = $tableDefinition | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions" -Method Post -Headers $headers -Body $body
```

#### Add Columns to Existing Table

```powershell
# Add email column
$emailColumn = @{
    "@odata.type" = "Microsoft.Dynamics.CRM.StringAttributeMetadata"
    "SchemaName" = "cr_email"
    "AttributeType" = "String"
    "FormatName" = @{ "Value" = "Email" }
    "MaxLength" = 100
    "DisplayName" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Email"; "LanguageCode" = 1033 }
        )
    }
}

# Get table's LogicalName or use EntitySetName
$tableName = "cr_contactsubmission"
Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$tableName')/Attributes" -Method Post -Headers $headers -Body ($emailColumn | ConvertTo-Json -Depth 10)

# Add message column (multiline text)
$messageColumn = @{
    "@odata.type" = "Microsoft.Dynamics.CRM.MemoAttributeMetadata"
    "SchemaName" = "cr_message"
    "AttributeType" = "Memo"
    "MaxLength" = 4000
    "DisplayName" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Message"; "LanguageCode" = 1033 }
        )
    }
}
Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$tableName')/Attributes" -Method Post -Headers $headers -Body ($messageColumn | ConvertTo-Json -Depth 10)

# Add submission date column
$dateColumn = @{
    "@odata.type" = "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata"
    "SchemaName" = "cr_submissiondate"
    "AttributeType" = "DateTime"
    "Format" = "DateAndTime"
    "DisplayName" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Submission Date"; "LanguageCode" = 1033 }
        )
    }
}
Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$tableName')/Attributes" -Method Post -Headers $headers -Body ($dateColumn | ConvertTo-Json -Depth 10)

# Add status choice column
$statusColumn = @{
    "@odata.type" = "Microsoft.Dynamics.CRM.PicklistAttributeMetadata"
    "SchemaName" = "cr_status"
    "AttributeType" = "Picklist"
    "DisplayName" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Status"; "LanguageCode" = 1033 }
        )
    }
    "OptionSet" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.OptionSetMetadata"
        "IsGlobal" = $false
        "OptionSetType" = "Picklist"
        "Options" = @(
            @{ "Value" = 1; "Label" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.Label"; "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "New"; "LanguageCode" = 1033 }) } }
            @{ "Value" = 2; "Label" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.Label"; "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Reviewed"; "LanguageCode" = 1033 }) } }
            @{ "Value" = 3; "Label" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.Label"; "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Responded"; "LanguageCode" = 1033 }) } }
            @{ "Value" = 4; "Label" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.Label"; "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Closed"; "LanguageCode" = 1033 }) } }
        )
    }
}
Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$tableName')/Attributes" -Method Post -Headers $headers -Body ($statusColumn | ConvertTo-Json -Depth 10)
```

### Helper Function for Table Creation

To simplify table creation, use this helper function:

```powershell
function New-DataverseTable {
    param(
        [string]$SchemaName,
        [string]$DisplayName,
        [string]$PluralDisplayName,
        [string]$Description = "",
        [string]$PrimaryColumnName = "cr_name",
        [string]$PrimaryColumnDisplayName = "Name"
    )

    $tableDefinition = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.EntityMetadata"
        "SchemaName" = $SchemaName
        "DisplayName" = @{
            "@odata.type" = "Microsoft.Dynamics.CRM.Label"
            "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $DisplayName; "LanguageCode" = 1033 })
        }
        "DisplayCollectionName" = @{
            "@odata.type" = "Microsoft.Dynamics.CRM.Label"
            "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $PluralDisplayName; "LanguageCode" = 1033 })
        }
        "Description" = @{
            "@odata.type" = "Microsoft.Dynamics.CRM.Label"
            "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $Description; "LanguageCode" = 1033 })
        }
        "OwnershipType" = "UserOwned"
        "HasNotes" = $false
        "HasActivities" = $false
        "PrimaryNameAttribute" = $PrimaryColumnName
        "Attributes" = @(
            @{
                "@odata.type" = "Microsoft.Dynamics.CRM.StringAttributeMetadata"
                "SchemaName" = $PrimaryColumnName
                "AttributeType" = "String"
                "FormatName" = @{ "Value" = "Text" }
                "MaxLength" = 100
                "DisplayName" = @{
                    "@odata.type" = "Microsoft.Dynamics.CRM.Label"
                    "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $PrimaryColumnDisplayName; "LanguageCode" = 1033 })
                }
                "IsPrimaryName" = $true
            }
        )
    }

    $body = $tableDefinition | ConvertTo-Json -Depth 10
    Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions" -Method Post -Headers $headers -Body $body
}

function Add-DataverseColumn {
    param(
        [string]$TableName,
        [string]$SchemaName,
        [string]$DisplayName,
        [string]$Type,  # String, Memo, Integer, Decimal, Money, DateTime, Boolean, Url
        [int]$MaxLength = 100
    )

    $columnTypes = @{
        "String" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.StringAttributeMetadata"; "AttributeType" = "String"; "FormatName" = @{ "Value" = "Text" }; "MaxLength" = $MaxLength }
        "Email" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.StringAttributeMetadata"; "AttributeType" = "String"; "FormatName" = @{ "Value" = "Email" }; "MaxLength" = $MaxLength }
        "Url" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.StringAttributeMetadata"; "AttributeType" = "String"; "FormatName" = @{ "Value" = "Url" }; "MaxLength" = 200 }
        "Memo" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.MemoAttributeMetadata"; "AttributeType" = "Memo"; "MaxLength" = $MaxLength }
        "Integer" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.IntegerAttributeMetadata"; "AttributeType" = "Integer"; "MinValue" = -2147483648; "MaxValue" = 2147483647 }
        "Money" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.MoneyAttributeMetadata"; "AttributeType" = "Money"; "PrecisionSource" = 2 }
        "DateTime" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata"; "AttributeType" = "DateTime"; "Format" = "DateAndTime" }
        "Boolean" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.BooleanAttributeMetadata"; "AttributeType" = "Boolean" }
    }

    $column = $columnTypes[$Type].Clone()
    $column["SchemaName"] = $SchemaName
    $column["DisplayName"] = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $DisplayName; "LanguageCode" = 1033 })
    }

    Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$TableName')/Attributes" -Method Post -Headers $headers -Body ($column | ConvertTo-Json -Depth 10)
}
```

### Common Table Templates

#### Product/Service Table

```powershell
# Create Product table
New-DataverseTable -SchemaName "cr_product" -DisplayName "Product" -PluralDisplayName "Products" -Description "Products and services offered"

# Add columns
Add-DataverseColumn -TableName "cr_product" -SchemaName "cr_description" -DisplayName "Description" -Type "Memo" -MaxLength 4000
Add-DataverseColumn -TableName "cr_product" -SchemaName "cr_price" -DisplayName "Price" -Type "Money"
Add-DataverseColumn -TableName "cr_product" -SchemaName "cr_category" -DisplayName "Category" -Type "String"
Add-DataverseColumn -TableName "cr_product" -SchemaName "cr_imageurl" -DisplayName "Image URL" -Type "Url"
Add-DataverseColumn -TableName "cr_product" -SchemaName "cr_isactive" -DisplayName "Is Active" -Type "Boolean"
```

#### Team Member Table

```powershell
# Create Team Member table
New-DataverseTable -SchemaName "cr_teammember" -DisplayName "Team Member" -PluralDisplayName "Team Members" -Description "Team members displayed on the website"

# Add columns
Add-DataverseColumn -TableName "cr_teammember" -SchemaName "cr_title" -DisplayName "Job Title" -Type "String"
Add-DataverseColumn -TableName "cr_teammember" -SchemaName "cr_email" -DisplayName "Email" -Type "Email"
Add-DataverseColumn -TableName "cr_teammember" -SchemaName "cr_bio" -DisplayName "Bio" -Type "Memo" -MaxLength 4000
Add-DataverseColumn -TableName "cr_teammember" -SchemaName "cr_photourl" -DisplayName "Photo URL" -Type "Url"
Add-DataverseColumn -TableName "cr_teammember" -SchemaName "cr_linkedin" -DisplayName "LinkedIn" -Type "Url"
Add-DataverseColumn -TableName "cr_teammember" -SchemaName "cr_displayorder" -DisplayName "Display Order" -Type "Integer"
```

#### Testimonial Table

```powershell
# Create Testimonial table
New-DataverseTable -SchemaName "cr_testimonial" -DisplayName "Testimonial" -PluralDisplayName "Testimonials" -Description "Customer testimonials and reviews"

# Add columns
Add-DataverseColumn -TableName "cr_testimonial" -SchemaName "cr_quote" -DisplayName "Quote" -Type "Memo" -MaxLength 2000
Add-DataverseColumn -TableName "cr_testimonial" -SchemaName "cr_company" -DisplayName "Company" -Type "String"
Add-DataverseColumn -TableName "cr_testimonial" -SchemaName "cr_role" -DisplayName "Role" -Type "String"
Add-DataverseColumn -TableName "cr_testimonial" -SchemaName "cr_rating" -DisplayName "Rating" -Type "Integer"
Add-DataverseColumn -TableName "cr_testimonial" -SchemaName "cr_photourl" -DisplayName "Photo URL" -Type "Url"
Add-DataverseColumn -TableName "cr_testimonial" -SchemaName "cr_isactive" -DisplayName "Is Active" -Type "Boolean"
```

#### FAQ Table

```powershell
# Create FAQ table
New-DataverseTable -SchemaName "cr_faq" -DisplayName "FAQ" -PluralDisplayName "FAQs" -Description "Frequently asked questions" -PrimaryColumnName "cr_question" -PrimaryColumnDisplayName "Question"

# Add columns
Add-DataverseColumn -TableName "cr_faq" -SchemaName "cr_answer" -DisplayName "Answer" -Type "Memo" -MaxLength 4000
Add-DataverseColumn -TableName "cr_faq" -SchemaName "cr_category" -DisplayName "Category" -Type "String"
Add-DataverseColumn -TableName "cr_faq" -SchemaName "cr_displayorder" -DisplayName "Display Order" -Type "Integer"
Add-DataverseColumn -TableName "cr_faq" -SchemaName "cr_isactive" -DisplayName "Is Active" -Type "Boolean"
```

---

## STEP 5: Add Sample Data

After creating tables, add realistic dummy data for testing.

### Using OData API via PowerShell

Create a PowerShell script to insert sample data:

```powershell
# Get access token
$token = (az account get-access-token --resource "https://<org>.crm.dynamics.com" --query accessToken -o tsv)

# Set headers
$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
    "OData-MaxVersion" = "4.0"
    "OData-Version" = "4.0"
}

# Environment URL (get from pac org who)
$baseUrl = "https://<org>.crm.dynamics.com/api/data/v9.2"
```

### Sample Data Templates

#### Contact Submissions

```powershell
$contacts = @(
    @{
        cr_name = "John Smith"
        cr_email = "john.smith@example.com"
        cr_message = "I'm interested in learning more about your services. Please contact me at your earliest convenience."
        cr_submissiondate = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
        cr_status = 1
    },
    @{
        cr_name = "Sarah Johnson"
        cr_email = "sarah.j@company.com"
        cr_message = "We're looking for a partner for our upcoming project. Would love to discuss collaboration opportunities."
        cr_submissiondate = (Get-Date).AddDays(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
        cr_status = 2
    },
    @{
        cr_name = "Michael Chen"
        cr_email = "m.chen@startup.io"
        cr_message = "Great website! I have some questions about pricing and availability."
        cr_submissiondate = (Get-Date).AddDays(-5).ToString("yyyy-MM-ddTHH:mm:ssZ")
        cr_status = 3
    }
)

foreach ($contact in $contacts) {
    $body = $contact | ConvertTo-Json
    Invoke-RestMethod -Uri "$baseUrl/cr_contactsubmissions" -Method Post -Headers $headers -Body $body
}
```

#### Products

```powershell
$products = @(
    @{
        cr_name = "Professional Consultation"
        cr_description = "One-on-one consultation with our expert team to discuss your business needs and create a tailored strategy."
        cr_price = 299.99
        cr_category = "Services"
        cr_imageurl = "https://images.unsplash.com/photo-1553877522-43269d4ea984?w=400"
        cr_isactive = $true
    },
    @{
        cr_name = "Enterprise Solution Package"
        cr_description = "Complete enterprise solution including setup, training, and 12 months of premium support."
        cr_price = 4999.99
        cr_category = "Packages"
        cr_imageurl = "https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=400"
        cr_isactive = $true
    },
    @{
        cr_name = "Starter Kit"
        cr_description = "Perfect for small businesses getting started. Includes basic setup and documentation."
        cr_price = 99.99
        cr_category = "Packages"
        cr_imageurl = "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400"
        cr_isactive = $true
    }
)

foreach ($product in $products) {
    $body = $product | ConvertTo-Json
    Invoke-RestMethod -Uri "$baseUrl/cr_products" -Method Post -Headers $headers -Body $body
}
```

#### Team Members

```powershell
$team = @(
    @{
        cr_name = "Emily Rodriguez"
        cr_title = "Chief Executive Officer"
        cr_email = "emily.r@company.com"
        cr_bio = "Emily has over 15 years of experience in technology leadership. She founded the company with a vision to transform how businesses operate."
        cr_photourl = "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=300"
        cr_linkedin = "https://linkedin.com/in/emilyrodriguez"
        cr_displayorder = 1
    },
    @{
        cr_name = "David Kim"
        cr_title = "Chief Technology Officer"
        cr_email = "david.k@company.com"
        cr_bio = "David brings deep technical expertise from his decade at leading tech companies. He leads our engineering and product teams."
        cr_photourl = "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=300"
        cr_linkedin = "https://linkedin.com/in/davidkim"
        cr_displayorder = 2
    },
    @{
        cr_name = "Lisa Thompson"
        cr_title = "Head of Customer Success"
        cr_email = "lisa.t@company.com"
        cr_bio = "Lisa ensures our customers achieve their goals. Her team provides world-class support and training."
        cr_photourl = "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=300"
        cr_linkedin = "https://linkedin.com/in/lisathompson"
        cr_displayorder = 3
    }
)

foreach ($member in $team) {
    $body = $member | ConvertTo-Json
    Invoke-RestMethod -Uri "$baseUrl/cr_teammembers" -Method Post -Headers $headers -Body $body
}
```

#### Testimonials

```powershell
$testimonials = @(
    @{
        cr_name = "Amanda Foster"
        cr_quote = "Working with this team transformed our business. Their solution increased our efficiency by 40% in just three months."
        cr_company = "TechStart Inc."
        cr_role = "Operations Director"
        cr_rating = 5
        cr_photourl = "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200"
        cr_isactive = $true
    },
    @{
        cr_name = "Robert Martinez"
        cr_quote = "The best investment we've made this year. Professional team, excellent support, and real results."
        cr_company = "Global Solutions Ltd"
        cr_role = "CEO"
        cr_rating = 5
        cr_photourl = "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200"
        cr_isactive = $true
    },
    @{
        cr_name = "Jennifer Wu"
        cr_quote = "I was skeptical at first, but they delivered beyond expectations. Highly recommend to any business looking to scale."
        cr_company = "Innovate Partners"
        cr_role = "Managing Partner"
        cr_rating = 5
        cr_photourl = "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=200"
        cr_isactive = $true
    }
)

foreach ($testimonial in $testimonials) {
    $body = $testimonial | ConvertTo-Json
    Invoke-RestMethod -Uri "$baseUrl/cr_testimonials" -Method Post -Headers $headers -Body $body
}
```

#### FAQs

```powershell
$faqs = @(
    @{
        cr_question = "How do I get started?"
        cr_answer = "Getting started is easy! Simply contact us through our form or schedule a free consultation. We'll discuss your needs and create a customized plan for your business."
        cr_category = "Getting Started"
        cr_displayorder = 1
        cr_isactive = $true
    },
    @{
        cr_question = "What support options are available?"
        cr_answer = "We offer multiple support tiers: Basic (email support within 48 hours), Professional (email and phone support within 24 hours), and Enterprise (dedicated support manager with 4-hour response time)."
        cr_category = "Support"
        cr_displayorder = 2
        cr_isactive = $true
    },
    @{
        cr_question = "Can I cancel my subscription?"
        cr_answer = "Yes, you can cancel your subscription at any time. We offer a 30-day money-back guarantee for new customers. For existing customers, your service will continue until the end of your billing period."
        cr_category = "Billing"
        cr_displayorder = 3
        cr_isactive = $true
    },
    @{
        cr_question = "Is my data secure?"
        cr_answer = "Absolutely. We use enterprise-grade encryption, comply with SOC 2 and GDPR requirements, and never share your data with third parties. Your data is backed up daily and stored in geographically distributed data centers."
        cr_category = "Security"
        cr_displayorder = 4
        cr_isactive = $true
    }
)

foreach ($faq in $faqs) {
    $body = $faq | ConvertTo-Json
    Invoke-RestMethod -Uri "$baseUrl/cr_faqs" -Method Post -Headers $headers -Body $body
}
```

### Verify Data

After inserting, verify the data:

```powershell
# List records in a table
Invoke-RestMethod -Uri "$baseUrl/cr_products?`$select=cr_name,cr_price" -Headers $headers | Select-Object -ExpandProperty value
```

---

## Next Steps

After setting up Dataverse tables with sample data, the next step is to configure table permissions so Power Pages can access the data.

> **Next Skill**: Run `/setup-webapi` to configure table permissions and enable Web API access for your Power Pages site.

---

## Update Memory Bank

After completing this skill, update `memory-bank.md` with the Dataverse setup details:

```markdown
### /setup-dataverse
- [x] Site analyzed for data requirements
- [x] Schema recommended and approved
- [x] Tables created: [LIST OF TABLES]
- [x] Sample data inserted: [NUMBER] records per table

## Created Resources

### Dataverse Tables

| Table Name | Display Name | Columns | Sample Data |
|------------|--------------|---------|-------------|
| cr_contactsubmission | Contact Submission | name, email, message, status, submissiondate | 3 records |
| cr_product | Product | name, description, price, category, imageurl, isactive | 3 records |
| [ADD MORE TABLES AS CREATED] |

### Technical Details
- Data Integration: OData Web API
- Environment URL: [URL from pac org who]

## Current Status

**Last Action**: Dataverse tables created with sample data

**Next Step**: Run `/setup-webapi` to configure table permissions and Web API access

## Notes

- [DATE]: Created [N] tables with sample data
```

---

## Troubleshooting

### Dataverse Web API Errors

- Verify Azure CLI is logged in: `az login`
- Check access token is valid: `az account get-access-token --resource <env-url>`
- Ensure you have appropriate Dataverse permissions (System Administrator or System Customizer)

### Table Creation Fails

- Verify schema name uses valid publisher prefix (e.g., `cr_`)
- Check that the table doesn't already exist
- Ensure all required metadata fields are included in the request
- Review the error response for specific validation failures

---

## Reference Documentation

- [Dataverse Web API](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview)
- [Dataverse Entity Metadata](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api)
- [OData Query Options](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-data-web-api)
